package planner

// Min-cost max-flow over a tiny graph (source, action nodes, rule nodes,
// quota node, sink). SPFA-based shortest augmenting paths are more than
// fast enough for <=22 rules and small demand multisets.

type flowEdge struct {
	to, rev  int
	cap      int
	cost     int64
	origCap  int
}

type flowGraph struct {
	g [][]flowEdge
}

func newFlowGraph(n int) *flowGraph { return &flowGraph{g: make([][]flowEdge, n)} }

func (f *flowGraph) addEdge(u, v, cap int, cost int64) {
	f.g[u] = append(f.g[u], flowEdge{to: v, rev: len(f.g[v]), cap: cap, cost: cost, origCap: cap})
	f.g[v] = append(f.g[v], flowEdge{to: u, rev: len(f.g[u]) - 1, cap: 0, cost: -cost})
}

// minCostFlow pushes up to want units from s to t and returns the flow
// achieved and its minimum cost.
func (f *flowGraph) minCostFlow(s, t, want int) (int, int64) {
	const inf = int64(1) << 62
	n := len(f.g)
	flow := 0
	var cost int64
	for flow < want {
		dist := make([]int64, n)
		inq := make([]bool, n)
		prevV := make([]int, n)
		prevE := make([]int, n)
		for i := range dist {
			dist[i] = inf
		}
		dist[s] = 0
		queue := []int{s}
		inq[s] = true
		for len(queue) > 0 {
			u := queue[0]
			queue = queue[1:]
			inq[u] = false
			for i, e := range f.g[u] {
				if e.cap > 0 && dist[u]+e.cost < dist[e.to] {
					dist[e.to] = dist[u] + e.cost
					prevV[e.to] = u
					prevE[e.to] = i
					if !inq[e.to] {
						inq[e.to] = true
						queue = append(queue, e.to)
					}
				}
			}
		}
		if dist[t] == inf {
			break
		}
		d := want - flow
		for v := t; v != s; v = prevV[v] {
			if c := f.g[prevV[v]][prevE[v]].cap; c < d {
				d = c
			}
		}
		for v := t; v != s; v = prevV[v] {
			e := &f.g[prevV[v]][prevE[v]]
			e.cap -= d
			rev := e.rev
			f.g[v][rev].cap += d
		}
		flow += d
		cost += int64(d) * dist[t]
	}
	return flow, cost
}

// usedFlow returns how many units flow through edge idx of node u.
func (f *flowGraph) usedFlow(u, idx int) int {
	e := f.g[u][idx]
	return f.g[e.to][e.rev].cap
}
