package location

import (
	"errors"
	"math"
	"sort"
)

// ErrInfeasible is returned when no open set and assignment can satisfy the
// capacity, unsplittability and coverage-distance constraints.
var ErrInfeasible = errors.New("location: instance is infeasible")

// Solve computes the exact optimum by enumerating open subsets (n <= 18)
// and, for each feasible subset, solving the unsplittable assignment by
// capacity-pruned backtracking (m <= 12).
func Solve(inst Instance) (Solution, error) {
	n, m := len(inst.Sites), len(inst.Demands)
	if n == 0 || m == 0 {
		return Solution{}, ErrInfeasible
	}
	if n > 18 || m > 12 {
		return Solution{}, errors.New("location: limits are 18 sites and 12 demands")
	}

	// eligible[j] lists site indices within the coverage limit of demand j.
	eligible := make([][]int, m)
	eDist := make([][]float64, m)
	totalSize := 0
	for j, d := range inst.Demands {
		if d.Size <= 0 {
			return Solution{}, errors.New("location: demand sizes must be positive")
		}
		totalSize += d.Size
		for i, s := range inst.Sites {
			if s.Capacity < 0 {
				return Solution{}, errors.New("location: capacities must be non-negative")
			}
			if dd := dist(d.X, d.Y, s.X, s.Y); dd <= inst.MaxDist {
				eligible[j] = append(eligible[j], i)
				eDist[j] = append(eDist[j], dd)
			}
		}
		if len(eligible[j]) == 0 {
			return Solution{}, ErrInfeasible
		}
	}

	// openCost[mask]: total opening cost of a subset, via lowbit DP.
	nMasks := 1 << n
	openCost := make([]float64, nMasks)
	capSum := make([]int, nMasks)
	for mask := 1; mask < nMasks; mask++ {
		low := mask & (-mask)
		i := bitsLog2(low)
		prev := mask ^ low
		openCost[mask] = openCost[prev] + inst.Sites[i].OpenCost
		capSum[mask] = capSum[prev] + inst.Sites[i].Capacity
	}

	best := math.Inf(1)
	var bestMask int
	var bestAssign []int

	for mask := 1; mask < nMasks; mask++ {
		if openCost[mask] >= best || capSum[mask] < totalSize {
			continue
		}
		// Every demand needs at least one open eligible site.
		ok := true
		for j := 0; j < m; j++ {
			found := false
			for _, i := range eligible[j] {
				if mask&(1<<i) != 0 {
					found = true
					break
				}
			}
			if !found {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		cost, assign, ok := assignOptimal(inst, mask, eligible, eDist, best-openCost[mask])
		if !ok {
			continue
		}
		if total := openCost[mask] + cost; total < best {
			best = total
			bestMask = mask
			bestAssign = assign
		}
	}
	if math.IsInf(best, 1) {
		return Solution{}, ErrInfeasible
	}

	sol := Solution{
		Open:       make([]bool, n),
		Assign:     bestAssign,
		Load:       make([]int, n),
		LowerBound: lowerBound(inst, eligible, eDist, totalSize),
		HasBudget:  inst.Budget > 0,
	}
	for i := 0; i < n; i++ {
		if bestMask&(1<<i) != 0 {
			sol.Open[i] = true
			sol.OpenCost += inst.Sites[i].OpenCost
		}
	}
	for j, i := range bestAssign {
		sol.Load[i] += inst.Demands[j].Size
		sol.AssignCost += dist(inst.Demands[j].X, inst.Demands[j].Y, inst.Sites[i].X, inst.Sites[i].Y)
	}
	sol.TotalCost = sol.OpenCost + sol.AssignCost
	sol.WithinBudget = !sol.HasBudget || sol.TotalCost <= inst.Budget
	return sol, nil
}

func bitsLog2(v int) int {
	r := 0
	for v > 1 {
		v >>= 1
		r++
	}
	return r
}

// assignOptimal finds the minimum-distance unsplittable assignment of all
// demands to sites open in mask, respecting capacities. It aborts as soon as
// the cost can no longer stay below limit.
func assignOptimal(inst Instance, mask int, eligible [][]int, eDist [][]float64, limit float64) (float64, []int, bool) {
	n, m := len(inst.Sites), len(inst.Demands)

	// Restrict eligibility to open sites; per-demand min distance for bounds.
	openEl := make([][]int, m)
	openDist := make([][]float64, m)
	minD := make([]float64, m)
	for j := 0; j < m; j++ {
		minD[j] = math.Inf(1)
		for k, i := range eligible[j] {
			if mask&(1<<i) != 0 {
				openEl[j] = append(openEl[j], i)
				openDist[j] = append(openDist[j], eDist[j][k])
				if eDist[j][k] < minD[j] {
					minD[j] = eDist[j][k]
				}
			}
		}
	}
	// suffixLB[t] = sum of min distances of demands ordered[t..].
	order := make([]int, m)
	for j := range order {
		order[j] = j
	}
	sort.Slice(order, func(a, b int) bool {
		if len(openEl[order[a]]) != len(openEl[order[b]]) {
			return len(openEl[order[a]]) < len(openEl[order[b]])
		}
		return inst.Demands[order[a]].Size > inst.Demands[order[b]].Size
	})
	suffixLB := make([]float64, m+1)
	for t := m - 1; t >= 0; t-- {
		suffixLB[t] = suffixLB[t+1] + minD[order[t]]
	}

	capLeft := make([]int, n)
	for i, s := range inst.Sites {
		capLeft[i] = s.Capacity
	}
	cur := make([]int, m)
	bestAsg := make([]int, m)
	best := limit

	var rec func(t int, cost float64) bool
	rec = func(t int, cost float64) bool {
		if cost+suffixLB[t] >= best {
			return false
		}
		if t == m {
			best = cost
			copy(bestAsg, cur)
			return true
		}
		j := order[t]
		progress := false
		for k, i := range openEl[j] {
			if capLeft[i] < inst.Demands[j].Size {
				continue
			}
			capLeft[i] -= inst.Demands[j].Size
			cur[j] = i
			if rec(t+1, cost+openDist[j][k]) {
				progress = true
			}
			capLeft[i] += inst.Demands[j].Size
		}
		return progress
	}
	if !rec(0, 0) {
		return 0, nil, false
	}
	out := make([]int, m)
	copy(out, bestAsg)
	return best, out, true
}

// lowerBound computes a certified lower bound on the optimum:
//   - opening: LP relaxation of min sum c_i x_i s.t. sum cap_i x_i >= total
//     demand (greedy by cost/capacity ratio, fractional last item);
//   - assignment: sum of per-demand minimum distances to any eligible site.
func lowerBound(inst Instance, eligible [][]int, eDist [][]float64, totalSize int) float64 {
	type rc struct {
		ratio float64
		cost  float64
		cap   int
	}
	items := make([]rc, 0, len(inst.Sites))
	for _, s := range inst.Sites {
		if s.Capacity > 0 {
			items = append(items, rc{float64(s.OpenCost) / float64(s.Capacity), s.OpenCost, s.Capacity})
		}
	}
	sort.Slice(items, func(a, b int) bool { return items[a].ratio < items[b].ratio })
	openLB := 0.0
	need := totalSize
	for _, it := range items {
		if need <= 0 {
			break
		}
		if it.cap <= need {
			openLB += it.cost
			need -= it.cap
		} else {
			openLB += it.ratio * float64(need)
			need = 0
		}
	}
	assignLB := 0.0
	for j := range inst.Demands {
		md := math.Inf(1)
		for _, dd := range eDist[j] {
			if dd < md {
				md = dd
			}
		}
		assignLB += md
	}
	return openLB + assignLB
}
