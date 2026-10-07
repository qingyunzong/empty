package main

// SolveBrute is the reference implementation used to cross-check Solve on
// short rows. It enumerates every possibility exhaustively: for each group
// (in every effective order, since groups are tried at every free position)
// it either leaves the group unseated or places it at every feasible start
// column, recursing until all groups are decided. This is a full permutation
// of subsets x orderings x positions, so it is only usable for tiny inputs.
func SolveBrute(available []bool, sizes []int, target int) Result {
	n := len(available)
	total := 0
	for _, s := range sizes {
		total += s
	}

	occupied := make([]bool, n)
	var best cost
	haveBest := false
	var bestPlacements []Placement
	var current []Placement

	var rec func(g int, c cost)
	rec = func(g int, c cost) {
		if g == len(sizes) {
			if !haveBest || c.better(best) {
				haveBest = true
				best = c
				bestPlacements = append([]Placement(nil), current...)
			}
			return
		}
		// Option 1: leave this group unseated.
		rec(g+1, c)
		// Option 2: seat it at every feasible start column.
		s := sizes[g]
		for p := 0; p+s <= n; p++ {
			feasible := true
			for k := 0; k < s; k++ {
				if !available[p+k] || occupied[p+k] {
					feasible = false
					break
				}
			}
			if !feasible {
				continue
			}
			d := 0
			for k := 0; k < s; k++ {
				occupied[p+k] = true
				if dd := p + k - target; dd < 0 {
					d -= dd
				} else {
					d += dd
				}
			}
			current = append(current, Placement{Group: g, Start: p})
			rec(g+1, cost{people: c.people + s, dist: c.dist + d})
			current = current[:len(current)-1]
			for k := 0; k < s; k++ {
				occupied[p+k] = false
			}
		}
	}
	rec(0, cost{})

	return buildResult(available, sizes, total, best, bestPlacements)
}
