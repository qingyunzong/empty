package main

import "math"

// BruteForce is an independent cross-check for the A* solver: a
// depth-first exhaustive enumeration of the finite state graph with
// best-so-far memoization. It shares only the transition generator;
// the search strategy (plain DFS, no priority queue, no heuristic)
// is deliberately different so pruning bugs cannot hide in both.
func BruteForce(sc *Scenario) (best int, found bool) {
	best = math.MaxInt32
	bestG := make(map[State]int)
	visits := 0
	start := State{Node: sc.Start, Fuel: sc.StartFuel}
	var dfs func(s State, g int)
	dfs = func(s State, g int) {
		visits++
		if visits > 20000000 {
			panic("brute force: visit cap exceeded")
		}
		if g >= best {
			return
		}
		if s.Node == sc.Goal {
			best = g
			return
		}
		for _, a := range sc.NextStates(s) {
			ng := g + a.Cost
			if og, ok := bestG[a.Next]; ok && og <= ng {
				continue
			}
			bestG[a.Next] = ng
			dfs(a.Next, ng)
		}
	}
	dfs(start, 0)
	return best, best < math.MaxInt32
}
