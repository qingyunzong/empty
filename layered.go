package statever

// LayeredResult is the outcome of the independent layered enumeration.
type LayeredResult struct {
	// MinBadDepth is the smallest number of steps in which a bad state is
	// reachable, or -1 if no bad state is reachable within the budget.
	MinBadDepth int
	// Layers[d] is the set of states reachable in exactly d steps
	// (first-visit frontier), for d in 0..Budget.
	Layers []map[int]bool
	// Budget is the step budget that was used.
	Budget int
}

// LayeredEnumerate is an independent cross-check of BoundedCheck: instead of
// path-carrying BFS it iteratively expands frontier sets layer by layer and
// records the first layer containing a bad state. It is used to verify
// counterexample lengths and budget-boundary behaviour by an implementation
// that shares no code with the BFS search.
func LayeredEnumerate(m *Model) LayeredResult {
	res := LayeredResult{MinBadDepth: -1, Budget: m.Budget}
	init := m.InitialIndex()
	seen := map[int]bool{init: true}
	frontier := map[int]bool{init: true}
	for depth := 0; depth <= m.Budget; depth++ {
		layer := map[int]bool{}
		for s := range frontier {
			layer[s] = true
		}
		res.Layers = append(res.Layers, layer)
		for s := range layer {
			if m.IsBad(s) {
				res.MinBadDepth = depth
				return res
			}
		}
		if depth == m.Budget {
			break
		}
		next := map[int]bool{}
		for s := range frontier {
			for ev := 0; ev < m.NumEvents(); ev++ {
				for _, dst := range m.Next(s, ev) {
					if !seen[dst] {
						seen[dst] = true
						next[dst] = true
					}
				}
			}
		}
		frontier = next
	}
	return res
}
