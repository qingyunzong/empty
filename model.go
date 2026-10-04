package diffconstraints

// BruteForce is an independent model used to cross-check Solve on
// small graphs. It enumerates every simple cycle of the constraint
// graph by full depth-first path exploration and reports feasibility:
// the system is infeasible exactly when some simple cycle's C values
// sum to a negative number. It shares no code with the solver.
func BruteForce(cons []Constraint) Certificate {
	adj := make(map[int][]Constraint)
	vars := make(map[int]bool)
	for _, c := range cons {
		adj[c.Y] = append(adj[c.Y], c) // edge Y -> X with weight C
		vars[c.X] = true
		vars[c.Y] = true
	}
	// Deterministic variable order.
	ordered := make([]int, 0, len(vars))
	for v := range vars {
		ordered = append(ordered, v)
	}
	for i := 1; i < len(ordered); i++ {
		for j := i; j > 0 && ordered[j-1] > ordered[j]; j-- {
			ordered[j-1], ordered[j] = ordered[j], ordered[j-1]
		}
	}

	var best []int // IDs of the first negative simple cycle found
	onPath := make(map[int]bool)
	var path []Constraint
	var dfs func(start, at, sum int)
	dfs = func(start, at, sum int) {
		if best != nil {
			return
		}
		for _, e := range adj[at] {
			if e.X == start {
				if sum+e.C < 0 {
					// Path edges run start->...->at; reverse so each
					// constraint's Y feeds the next constraint's X.
					ids := append(append([]int(nil), idsOf(path)...), e.ID)
					for i, j := 0, len(ids)-1; i < j; i, j = i+1, j-1 {
						ids[i], ids[j] = ids[j], ids[i]
					}
					best = ids
					return
				}
				continue
			}
			if onPath[e.X] {
				continue
			}
			onPath[e.X] = true
			path = append(path, e)
			dfs(start, e.X, sum+e.C)
			path = path[:len(path)-1]
			onPath[e.X] = false
			if best != nil {
				return
			}
		}
	}
	for _, s := range ordered {
		onPath[s] = true
		dfs(s, s, 0)
		onPath[s] = false
		if best != nil {
			return &Infeasible{Cycle: best}
		}
	}

	// Feasible: derive a model potential by longest-path style bounds.
	// For every pair, the tightest simple path gives an upper bound on
	// dist; potentials of zero minus the all-pairs shortest simple-path
	// closure satisfy all constraints when no negative cycle exists.
	pot := make(map[int]int, len(vars))
	// Compute shortest simple-path distances from each source by DFS.
	dist := make(map[int]map[int]int, len(vars))
	for _, s := range ordered {
		d := make(map[int]int, len(vars))
		d[s] = 0
		var relax func(at, sum int, seen map[int]bool)
		seen := map[int]bool{s: true}
		relax = func(at, sum int, _ map[int]bool) {
			if cur, ok := d[at]; !ok || sum < cur {
				d[at] = sum
			}
			for _, e := range adj[at] {
				if seen[e.X] {
					continue
				}
				seen[e.X] = true
				relax(e.X, sum+e.C, seen)
				seen[e.X] = false
			}
		}
		relax(s, 0, seen)
		dist[s] = d
	}
	// Potential for v: minimum over sources s of dist[s][v] (0 if
	// unreachable, matching the super-source semantics of Solve).
	for _, v := range ordered {
		m := 0
		first := true
		for _, s := range ordered {
			if d, ok := dist[s][v]; ok && (first || d < m) {
				m, first = d, false
			}
		}
		if m > 0 {
			m = 0
		}
		pot[v] = m
	}
	return &Feasible{Potentials: pot}
}

func idsOf(path []Constraint) []int {
	ids := make([]int, len(path))
	for i, c := range path {
		ids[i] = c.ID
	}
	return ids
}
