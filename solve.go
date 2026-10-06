package main

import (
	"fmt"
	"math/bits"
	"sort"
)

// Cost model (register-symmetric, move-free):
//   - an interval that starts spilled pays StoreCost (its definition is
//     stored to memory);
//   - a register -> spilled transition between consecutive points pays
//     StoreCost; a spilled -> register transition pays LoadCost;
//   - interval death is free, regardless of state.
// At each point the set of register-resident live intervals must fit into
// the registers not reserved by a call at that point.

// Event is one spill-store or reload-load in the certificate.
type Event struct {
	Point    int    `json:"point"`
	Interval string `json:"interval"`
	Op       string `json:"op"` // "load" or "store"
	Cost     int    `json:"cost"`
}

// PointState is the per-point occupancy certificate.
type PointState struct {
	Point     int               `json:"point"`
	Occupancy map[string]string `json:"occupancy"` // register -> interval
	Spilled   []string          `json:"spilled"`   // live but in memory
	Reserved  []string          `json:"reserved"`  // registers reserved by calls
}

// Solution is the full allocation certificate.
type Solution struct {
	TotalCost int          `json:"totalCost"`
	Points    []PointState `json:"points"`
	Events    []Event      `json:"events"`
}

// enumSubsets calls fn for every subset of items (as a bitmask of global
// interval indices) whose size is at most maxPop.
func enumSubsets(items []int, maxPop int, fn func(mask uint32)) {
	var rec func(k int, mask uint32, pop int)
	rec = func(k int, mask uint32, pop int) {
		if k == len(items) {
			fn(mask)
			return
		}
		rec(k+1, mask, pop)
		if pop < maxPop {
			rec(k+1, mask|1<<uint(items[k]), pop+1)
		}
	}
	rec(0, 0, 0)
}

// transitionCost computes the spill/load cost of moving from register-set
// prev (at point p-1) to register-set cur (at point p).
func (inst *instance) transitionCost(p int, prev, cur uint32) int {
	cost := 0
	inPrevLive := map[int]bool{}
	if p > 0 {
		for _, i := range inst.live[p-1] {
			inPrevLive[i] = true
		}
	}
	for _, i := range inst.live[p] {
		iv := inst.in.Intervals[i]
		inCur := cur>>uint(i)&1 == 1
		if !inPrevLive[i] {
			if !inCur {
				cost += iv.StoreCost // starts spilled
			}
			continue
		}
		inPrev := prev>>uint(i)&1 == 1
		switch {
		case inPrev && !inCur:
			cost += iv.StoreCost
		case !inPrev && inCur:
			cost += iv.LoadCost
		}
	}
	return cost
}

// solve runs the exact DP and returns the optimal register-set per point.
func (inst *instance) solve() ([]uint32, int, error) {
	P := inst.numPoints
	dp := map[uint32]int{}
	parents := make([]map[uint32]uint32, P)

	enumSubsets(inst.live[0], len(inst.avail[0]), func(mask uint32) {
		dp[mask] = inst.transitionCost(0, 0, mask)
	})
	if len(dp) == 0 {
		return nil, 0, fmt.Errorf("no feasible assignment at point 0")
	}

	for p := 1; p < P; p++ {
		next := map[uint32]int{}
		par := map[uint32]uint32{}
		enumSubsets(inst.live[p], len(inst.avail[p]), func(cur uint32) {
			best := -1
			var bestPrev uint32
			for prev, c := range dp {
				tc := c + inst.transitionCost(p, prev, cur)
				if best < 0 || tc < best {
					best, bestPrev = tc, prev
				}
			}
			next[cur] = best
			par[cur] = bestPrev
		})
		dp, parents[p] = next, par
	}

	bestCost := -1
	var bestMask uint32
	for mask, c := range dp {
		if bestCost < 0 || c < bestCost {
			bestCost, bestMask = c, mask
		}
	}
	masks := make([]uint32, P)
	masks[P-1] = bestMask
	for p := P - 1; p > 0; p-- {
		masks[p-1] = parents[p][masks[p]]
	}
	return masks, bestCost, nil
}

// assignRegisters turns the optimal register-sets into concrete register
// assignments, preferring to keep an interval in its previous register.
func (inst *instance) assignRegisters(masks []uint32) []map[int]int {
	P := inst.numPoints
	assign := make([]map[int]int, P) // assign[p]: register -> interval
	prev := map[int]int{}            // interval -> register
	for p := 0; p < P; p++ {
		occ := map[int]int{}
		used := map[int]bool{}
		var inReg []int
		for _, i := range inst.live[p] {
			if masks[p]>>uint(i)&1 == 1 {
				inReg = append(inReg, i)
			}
		}
		avail := map[int]bool{}
		for _, r := range inst.avail[p] {
			avail[r] = true
		}
		var rest []int
		for _, i := range inReg {
			if r, ok := prev[i]; ok && avail[r] && !used[r] {
				occ[r] = i
				used[r] = true
			} else {
				rest = append(rest, i)
			}
		}
		free := []int{}
		for _, r := range inst.avail[p] {
			if !used[r] {
				free = append(free, r)
			}
		}
		for k, i := range rest {
			occ[free[k]] = i
		}
		assign[p] = occ
		prev = map[int]int{}
		for r, i := range occ {
			prev[i] = r
		}
	}
	return assign
}

// buildSolution assembles the certificate from masks and assignments.
func (inst *instance) buildSolution(masks []uint32, assign []map[int]int, total int) *Solution {
	sol := &Solution{TotalCost: total}
	for p := 0; p < inst.numPoints; p++ {
		ps := PointState{
			Point:     p,
			Occupancy: map[string]string{},
			Reserved:  inst.reservedNames[p],
		}
		for r, i := range assign[p] {
			ps.Occupancy[inst.in.Registers[r]] = inst.in.Intervals[i].Name
		}
		for _, i := range inst.live[p] {
			if masks[p]>>uint(i)&1 == 0 {
				ps.Spilled = append(ps.Spilled, inst.in.Intervals[i].Name)
			}
		}
		sort.Strings(ps.Spilled)
		sol.Points = append(sol.Points, ps)
	}
	// Events from state transitions, independent of concrete registers.
	for i, iv := range inst.in.Intervals {
		prevInReg := false
		for p := iv.Start; p < iv.End; p++ {
			inReg := masks[p]>>uint(i)&1 == 1
			switch {
			case p == iv.Start && !inReg:
				sol.Events = append(sol.Events, Event{p, iv.Name, "store", iv.StoreCost})
			case p > iv.Start && inReg && !prevInReg:
				sol.Events = append(sol.Events, Event{p, iv.Name, "load", iv.LoadCost})
			case p > iv.Start && !inReg && prevInReg:
				sol.Events = append(sol.Events, Event{p, iv.Name, "store", iv.StoreCost})
			}
			prevInReg = inReg
		}
	}
	sort.Slice(sol.Events, func(a, b int) bool {
		if sol.Events[a].Point != sol.Events[b].Point {
			return sol.Events[a].Point < sol.Events[b].Point
		}
		return sol.Events[a].Interval < sol.Events[b].Interval
	})
	return sol
}

// solveInstance runs the full pipeline: DP, register assignment, certificate.
func solveInstance(in *Input) (*Solution, error) {
	if err := validate(in); err != nil {
		return nil, err
	}
	inst := buildInstance(in)
	masks, cost, err := inst.solve()
	if err != nil {
		return nil, err
	}
	assign := inst.assignRegisters(masks)
	return inst.buildSolution(masks, assign, cost), nil
}

// popcountMask is a small helper kept for tests.
func popcountMask(m uint32) int { return bits.OnesCount32(m) }
