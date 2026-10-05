package regalloc

import "math"

// BruteForce exhaustively enumerates every per-point assignment of live
// intervals to concrete registers or memory and returns the minimum cost,
// under the same model as Solve: an interval must be in a register at its
// definition point and at its last use.
// It is exponential and intended only for small instances (tests and the
// -brute cross-check); unlike Solve it tracks register identity, so it is
// an independent check of the DP's central assumption that register
// identity does not affect the optimum.
func BruteForce(in *Input) (cost int64, feasible bool) {
	if err := in.Validate(); err != nil {
		return 0, false
	}
	n := len(in.Intervals)
	P := in.numPoints()
	reserved := in.reservedAt()
	R := in.NumRegisters

	const notLive = -2
	best := int64(math.MaxInt64 / 4)
	// grid[pt][j] is the location of interval j at point pt along the
	// current search path. Each point writes only its own row, so rows of
	// shallower points survive deeper recursion and backtracking is safe.
	grid := make([][]int, P)
	for i := range grid {
		grid[i] = make([]int, n)
	}
	emptyRow := make([]int, n)
	for k := range emptyRow {
		emptyRow[k] = notLive
	}

	// place assigns locations to the live intervals of point pt (starting
	// at interval index j), then recurses into point pt+1.
	var place func(pt int, j int, used uint32, runCost int64)
	place = func(pt int, j int, used uint32, runCost int64) {
		if runCost >= best {
			return
		}
		row := grid[pt]
		if j == 0 {
			for k := range row {
				row[k] = notLive
			}
		}
		// Find next live interval index >= j.
		for j < n && !(in.Intervals[j].Start <= pt && pt < in.Intervals[j].End) {
			j++
		}
		if j == n {
			// Point fully assigned; move to next point.
			if pt+1 == P {
				if runCost < best {
					best = runCost
				}
				return
			}
			place(pt+1, 0, 0, runCost)
			return
		}
		prevRow := emptyRow
		if pt > 0 {
			prevRow = grid[pt-1]
		}
		iv := in.Intervals[j]
		// Candidate locations: memory (unless the interval must be in a
		// register here) and every free, non-reserved register.
		mustReg := iv.Start == pt || iv.End-1 == pt
		if !mustReg {
			row[j] = -1
			extra := int64(0)
			if prevRow[j] >= 0 {
				extra = iv.StoreCost
			}
			place(pt, j+1, used, runCost+extra)
		}
		for r := 0; r < R; r++ {
			if used&(1<<uint(r)) != 0 {
				continue
			}
			res := false
			for _, rr := range reserved[pt] {
				if rr == r {
					res = true
					break
				}
			}
			if res {
				continue
			}
			row[j] = r
			extra := int64(0)
			if prevRow[j] == -1 {
				extra = iv.LoadCost
			}
			place(pt, j+1, used|(1<<uint(r)), runCost+extra)
		}
		row[j] = notLive
	}
	place(0, 0, 0, 0)
	if best == int64(math.MaxInt64/4) {
		return 0, false
	}
	return best, true
}
