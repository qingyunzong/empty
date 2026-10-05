package route

// Enumeration is the brute-force reference result over all simple paths.
type Enumeration struct {
	Found   bool
	Best    Simulation
	Paths   int // number of feasible simple paths evaluated
	Visited int // number of simple paths from Start to End examined
}

// Enumerate evaluates every simple path (no repeated nodes, at most
// MaxNodes nodes) from Start to End with the exact simulator and keeps
// the best by (cost, time). It is the ground-truth cross-check for the
// state-space search.
func (p *Problem) Enumerate() Enumeration {
	adj := p.outAdj()
	var en Enumeration
	visited := make([]bool, p.NumNodes)
	visited[p.Start] = true
	path := make([]int, 0, p.MaxNodes-1)
	var dfs func(u int)
	dfs = func(u int) {
		if u == p.End {
			en.Visited++
			sim := p.Simulate(path)
			if sim.OK {
				en.Paths++
				if !en.Found || sim.Cost < en.Best.Cost ||
					(sim.Cost == en.Best.Cost && sim.Time < en.Best.Time) {
					en.Found = true
					en.Best = sim
				}
			}
			return
		}
		if len(path)+1 >= p.MaxNodes {
			return // adding one more node would exceed the node limit
		}
		for _, eid := range adj[u] {
			v := p.Edges[eid].To
			if visited[v] {
				continue
			}
			visited[v] = true
			path = append(path, eid)
			dfs(v)
			path = path[:len(path)-1]
			visited[v] = false
		}
	}
	dfs(p.Start)
	return en
}
