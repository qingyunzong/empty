package dataeng

import "math/big"

// flowEdge is a residual network arc. orig is the residual capacity before any
// flow; rev points at the reverse arc inside the same node's slice.
type flowEdge struct {
	to   int
	rev  int
	cap  *big.Rat
	orig *big.Rat
}

// rationalDinic is an exact maximum-flow implementation over big.Rat
// capacities. Termination is structural: every successful blocking augment
// saturates at least one arc and raises the BFS level of the sink, while
// capacities are exact rationals, so no epsilon comparison is ever needed.
type rationalDinic struct {
	n     int
	graph [][]flowEdge
	level []int
	ptr   []int
}

func newRationalDinic(n int) *rationalDinic {
	return &rationalDinic{
		n:     n,
		graph: make([][]flowEdge, n),
		level: make([]int, n),
		ptr:   make([]int, n),
	}
}

// addEdge adds a forward arc with capacity cap and a zero-capacity reverse arc.
func (d *rationalDinic) addEdge(from, to int, cap *big.Rat) {
	forward := flowEdge{to: to, rev: len(d.graph[to]), cap: ratCopy(cap), orig: ratCopy(cap)}
	backward := flowEdge{to: from, rev: len(d.graph[from]), cap: new(big.Rat), orig: new(big.Rat)}
	d.graph[from] = append(d.graph[from], forward)
	d.graph[to] = append(d.graph[to], backward)
}

func (d *rationalDinic) bfs(s, t int) bool {
	for i := range d.level {
		d.level[i] = -1
	}
	d.level[s] = 0
	queue := []int{s}
	for head := 0; head < len(queue); head++ {
		u := queue[head]
		for k := range d.graph[u] {
			e := &d.graph[u][k]
			if d.level[e.to] == -1 && e.cap.Sign() > 0 {
				d.level[e.to] = d.level[u] + 1
				queue = append(queue, e.to)
			}
		}
	}
	return d.level[t] != -1
}

// dfs pushes up to pushed along a level-increasing path and returns the amount
// actually moved (which may be zero).
func (d *rationalDinic) dfs(u, t int, pushed *big.Rat) *big.Rat {
	if u == t {
		return pushed
	}
	for ; d.ptr[u] < len(d.graph[u]); d.ptr[u]++ {
		e := &d.graph[u][d.ptr[u]]
		if e.cap.Sign() == 0 || d.level[e.to] != d.level[u]+1 {
			continue
		}
		limit := pushed
		if e.cap.Cmp(limit) < 0 {
			limit = e.cap
		}
		got := d.dfs(e.to, t, limit)
		if got.Sign() == 0 {
			continue
		}
		// Consume got on the forward residual arc and credit the reverse arc.
		e.cap = ratSub(e.cap, got)
		rev := &d.graph[e.to][e.rev]
		rev.cap = ratSum(rev.cap, got)
		if e.cap.Sign() == 0 {
			d.ptr[u]++
		}
		return got
	}
	return new(big.Rat)
}

// maxFlow computes the exact s-t maximum flow. The returned flow is the sum of
// all successful augmentations; with rational capacities Dinic performs
// finitely many blocking phases because each phase strictly increases the
// shortest residual distance to the sink.
func (d *rationalDinic) maxFlow(s, t int) *big.Rat {
	flow := new(big.Rat)
	inf := new(big.Rat).SetInt64(1 << 60)
	for d.bfs(s, t) {
		for i := range d.ptr {
			d.ptr[i] = 0
		}
		for {
			got := d.dfs(s, t, inf)
			if got.Sign() == 0 {
				break
			}
			flow.Add(flow, got)
		}
	}
	return flow
}

// reachableFrom returns the nodes reachable from s on residual arcs with
// strictly positive capacity, i.e. the source side of the minimum cut.
func (d *rationalDinic) reachableFrom(s int) []bool {
	mark := make([]bool, d.n)
	mark[s] = true
	queue := []int{s}
	for head := 0; head < len(queue); head++ {
		u := queue[head]
		for k := range d.graph[u] {
			e := &d.graph[u][k]
			if !mark[e.to] && e.cap.Sign() > 0 {
				mark[e.to] = true
				queue = append(queue, e.to)
			}
		}
	}
	return mark
}

// arcFlow returns the amount carried by forward arc index k from u: original
// capacity minus remaining residual capacity.
func (d *rationalDinic) arcFlow(u, k int) *big.Rat {
	e := d.graph[u][k]
	return ratSub(e.orig, e.cap)
}
