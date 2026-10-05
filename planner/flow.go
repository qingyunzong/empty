package planner

// Dinic max-flow over the small assignment networks built per candidate subset.

type flowEdge struct {
	to, rev, cap int
}

type dinic struct {
	g     [][]flowEdge
	level []int
	it    []int
}

func newDinic(n int) *dinic {
	return &dinic{g: make([][]flowEdge, n), level: make([]int, n), it: make([]int, n)}
}

// addEdge adds a forward edge and returns its index in g[v].
func (d *dinic) addEdge(v, u, cap int) int {
	d.g[v] = append(d.g[v], flowEdge{to: u, rev: len(d.g[u]), cap: cap})
	d.g[u] = append(d.g[u], flowEdge{to: v, rev: len(d.g[v]) - 1, cap: 0})
	return len(d.g[v]) - 1
}

func (d *dinic) bfs(s, t int) bool {
	for i := range d.level {
		d.level[i] = -1
	}
	d.level[s] = 0
	q := []int{s}
	for len(q) > 0 {
		v := q[0]
		q = q[1:]
		for _, e := range d.g[v] {
			if e.cap > 0 && d.level[e.to] < 0 {
				d.level[e.to] = d.level[v] + 1
				q = append(q, e.to)
			}
		}
	}
	return d.level[t] >= 0
}

func (d *dinic) dfs(v, t, f int) int {
	if v == t {
		return f
	}
	for ; d.it[v] < len(d.g[v]); d.it[v]++ {
		i := d.it[v]
		e := &d.g[v][i]
		if e.cap > 0 && d.level[e.to] == d.level[v]+1 {
			if pushed := d.dfs(e.to, t, min(f, e.cap)); pushed > 0 {
				e.cap -= pushed
				d.g[e.to][e.rev].cap += pushed
				return pushed
			}
		}
	}
	return 0
}

func (d *dinic) maxFlow(s, t int) int {
	flow := 0
	for d.bfs(s, t) {
		for i := range d.it {
			d.it[i] = 0
		}
		for {
			pushed := d.dfs(s, t, 1<<30)
			if pushed == 0 {
				break
			}
			flow += pushed
		}
	}
	return flow
}

// assign attempts to distribute the full demand multiset over the selected
// rules respecting per-rule capacities. It returns rule -> action -> count.
func (p *prepared) assign(sel []int) (map[int]map[int]int, bool) {
	numA := len(p.demandActions)
	src := 0
	sink := 1 + numA + len(sel)
	d := newDinic(sink + 1)
	actionNode := func(i int) int { return 1 + i }
	ruleNode := func(j int) int { return 1 + numA + j }

	for i := range p.demandActions {
		d.addEdge(src, actionNode(i), p.demandCounts[i])
	}
	type edgeRef struct {
		rule, action, node, idx int
	}
	var refs []edgeRef
	for j, r := range sel {
		for i, a := range p.demandActions {
			if p.ruleActionMask[r]&(1<<uint(a)) != 0 {
				idx := d.addEdge(actionNode(i), ruleNode(j), p.totalDemand)
				refs = append(refs, edgeRef{rule: r, action: a, node: actionNode(i), idx: idx})
			}
		}
		d.addEdge(ruleNode(j), sink, p.effCap(r))
	}
	if d.maxFlow(src, sink) != p.totalDemand {
		return nil, false
	}
	out := map[int]map[int]int{}
	for _, rf := range refs {
		used := p.totalDemand - d.g[rf.node][rf.idx].cap
		if used > 0 {
			if out[rf.rule] == nil {
				out[rf.rule] = map[int]int{}
			}
			out[rf.rule][rf.action] += used
		}
	}
	return out, true
}
