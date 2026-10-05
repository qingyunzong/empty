package main

// Exhaustive is the independent cross-check: a plain depth-first enumeration
// of the finite state graph with no dominance pruning, no cost bounds and no
// memoization. The state graph is acyclic because every transition strictly
// increases time (edge time >= 1, refuel time >= 1), so enumeration always
// terminates. It returns the minimum cost over all complete routes to the
// goal.
func Exhaustive(g *Graph) (cost int, found bool) {
	best := -1
	var rec func(s State, c int)
	rec = func(s State, c int) {
		if s.Node == g.Goal {
			// Leaving the goal and coming back can only add non-negative
			// cost, so the first arrival already dominates later ones.
			if best < 0 || c < best {
				best = c
			}
			return
		}
		for _, succ := range g.Successors(s) {
			rec(succ.Next, c+succ.Tr.Cost)
		}
	}
	rec(g.InitialState(), 0)
	if best < 0 {
		return 0, false
	}
	return best, true
}
