package transferplan

// Solve returns a minimum-cost plan for p, or ErrInfeasible if no plan
// satisfies all demands.
//
// The fixed loss makes the problem a fixed-charge network flow: an
// edge e that carries flow sends f = g + Loss units to deliver g, so
// enabling it costs a constant Loss*Cost on top of the per-unit cost.
// Solve enumerates the subset of enabled edges (at most 2^MaxEdges)
// and solves a small min-cost flow for each, which is exact and fast
// at the problem's scale (<= MaxNodes nodes, <= MaxEdges edges).
func Solve(p Problem) (Plan, error) {
	if err := p.Validate(); err != nil {
		return Plan{}, err
	}
	m := len(p.Edges)
	best := Plan{Cost: -1}
	for mask := uint(0); mask < 1<<m; mask++ {
		plan, ok := solveSubset(p, mask)
		if ok && (best.Cost < 0 || plan.Cost < best.Cost) {
			best = plan
		}
	}
	if best.Cost < 0 {
		return Plan{}, ErrInfeasible
	}
	return best, nil
}

// solveSubset solves the subproblem in which exactly the edges of mask
// may carry flow. It returns the cheapest corresponding plan, using
// the flow's real cost (edges that end up unused pay no loss).
func solveSubset(p Problem, mask uint) (Plan, bool) {
	n := p.Nodes
	s, t := n, n+1

	// Losses of enabled out-edges are deducted from each node's stock.
	lossOut := make([]int, n)
	for k, e := range p.Edges {
		if mask&(1<<k) != 0 {
			lossOut[e.From] += e.Loss
		}
	}

	mf := newMinCostFlow(n + 2)
	required := 0 // total flow that must reach t
	for i := 0; i < n; i++ {
		// slack = supply - demand - losses; negative slack is the
		// amount node i must receive, positive slack what it may send.
		if slack := p.Supply[i] - p.Demand[i] - lossOut[i]; slack >= 0 {
			mf.addEdge(s, i, slack, 0)
		} else {
			mf.addEdge(i, t, -slack, 0)
			required += -slack
		}
	}
	type edgeRef struct{ from, idx int }
	refs := make(map[int]edgeRef) // problem edge -> residual position
	for k, e := range p.Edges {
		if mask&(1<<k) == 0 {
			continue
		}
		if cap := e.Cap - e.Loss; cap > 0 {
			refs[k] = edgeRef{e.From, len(mf.g[e.From])}
			mf.addEdge(e.From, e.To, cap, e.Cost)
		}
	}

	flow, _ := mf.minCostFlow(s, t, required)
	if flow < required {
		return Plan{}, false
	}

	flows := make([]int, len(p.Edges))
	cost := 0
	for k, ref := range refs {
		e := p.Edges[k]
		g := e.Cap - e.Loss - mf.g[ref.from][ref.idx].cap
		if g > 0 {
			flows[k] = g + e.Loss
			cost += flows[k] * e.Cost
		}
	}
	return Plan{Cost: cost, Flows: flows}, true
}

// minCostFlow is a successive-shortest-paths min-cost flow over a
// residual network, sufficient for the tiny graphs built above.
type minCostFlow struct {
	g [][]resEdge
}

type resEdge struct {
	to, rev, cap, cost int
}

func newMinCostFlow(n int) *minCostFlow {
	return &minCostFlow{g: make([][]resEdge, n)}
}

func (mf *minCostFlow) addEdge(from, to, cap, cost int) {
	mf.g[from] = append(mf.g[from], resEdge{to: to, rev: len(mf.g[to]), cap: cap, cost: cost})
	mf.g[to] = append(mf.g[to], resEdge{to: from, rev: len(mf.g[from]) - 1, cap: 0, cost: -cost})
}

// minCostFlow augments along cheapest s-t paths until maxf units flow
// or no path remains, and returns the achieved flow and its cost.
func (mf *minCostFlow) minCostFlow(s, t, maxf int) (flow, cost int) {
	n := len(mf.g)
	const inf = int(^uint(0) >> 1)
	for flow < maxf {
		dist := make([]int, n)
		prevV := make([]int, n)
		prevE := make([]int, n)
		for i := range dist {
			dist[i] = inf
		}
		dist[s] = 0
		// Bellman-Ford: graphs are tiny and costs may be negative on
		// residual edges.
		for updated := true; updated; {
			updated = false
			for v := 0; v < n; v++ {
				if dist[v] == inf {
					continue
				}
				for i, e := range mf.g[v] {
					if e.cap > 0 && dist[v]+e.cost < dist[e.to] {
						dist[e.to] = dist[v] + e.cost
						prevV[e.to] = v
						prevE[e.to] = i
						updated = true
					}
				}
			}
		}
		if dist[t] == inf {
			break
		}
		d := maxf - flow
		for v := t; v != s; v = prevV[v] {
			if c := mf.g[prevV[v]][prevE[v]].cap; c < d {
				d = c
			}
		}
		flow += d
		cost += d * dist[t]
		for v := t; v != s; v = prevV[v] {
			e := &mf.g[prevV[v]][prevE[v]]
			e.cap -= d
			mf.g[v][e.rev].cap += d
		}
	}
	return flow, cost
}
