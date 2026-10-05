package planner

import (
	"math"
	"sort"
)

// maxVerifyFlowCalls caps max-flow invocations inside the subset-enumeration
// cross-check so adversarial specs cannot make verification runaway.
const maxVerifyFlowCalls = 300000

// maxAssignEnumUnits caps demand units for the assignment enumeration check.
const maxAssignEnumUnits = 12

// maxAssignEnumNodes caps recursion nodes for the assignment enumeration check.
const maxAssignEnumNodes = 2000000

// maxAssignEnumCount caps the reported feasible-assignment count.
const maxAssignEnumCount = 1000000

// SubsetVerification reports the independent full-subset-enumeration check.
type SubsetVerification struct {
	TotalSubsets    uint64   `json:"totalSubsets"`
	FeasibleSubsets uint64   `json:"feasibleSubsets"`
	OptimalCost     *int64   `json:"optimalCost"`
	OptimalRules    []string `json:"optimalRules"`
	Completed       bool     `json:"completed"` // false if flow-call budget exhausted
	MatchesSolver   bool     `json:"matchesSolver"`
}

// subsetOK is the independent feasibility check used by the enumerator:
// exclusion, prerequisites, coverage, capacity, and assignment flow.
func (p *prepared) subsetOK(sel uint64) bool {
	var cover uint64
	capSum := 0
	var selList []int
	for bits := sel; bits != 0; bits &= bits - 1 {
		r := bitsTrailing(bits)
		bit := uint64(1) << uint(r)
		if p.excludesMask[r]&sel != 0 {
			return false
		}
		if p.requiresMask[r]&^sel != 0 {
			return false
		}
		if p.excludesMask[r]&bit != 0 {
			return false
		}
		cover |= p.ruleActionMask[r]
		capSum = min(p.totalDemand, capSum+p.effCap(r))
		selList = append(selList, r)
	}
	if cover&p.demandMask != p.demandMask || capSum < p.totalDemand {
		return false
	}
	_, ok := p.assign(selList)
	return ok
}

// verifySubsets re-derives the optimum by exhaustive enumeration over all
// 2^m eligible-rule subsets and compares it with the solver's answer.
func (p *prepared) verifySubsets(sol *Solution) SubsetVerification {
	v := SubsetVerification{Completed: true}
	if !p.quotaOK() {
		v.MatchesSolver = !sol.Feasible
		return v
	}
	m := len(p.elig)
	flowCalls := 0
	bestCost := int64(math.MaxInt64)
	var bestIDs []string
	found := false

	var rec func(pos int, cost int64, sel uint64)
	rec = func(pos int, cost int64, sel uint64) {
		if !v.Completed {
			return
		}
		if pos == m {
			v.TotalSubsets++
			if found && cost > bestCost {
				return
			}
			// Cheap filters before the flow check.
			var cover uint64
			capSum := 0
			cheap := true
			for bits := sel; bits != 0 && cheap; bits &= bits - 1 {
				r := bitsTrailing(bits)
				if p.excludesMask[r]&sel != 0 || p.requiresMask[r]&^sel != 0 {
					cheap = false
					break
				}
				cover |= p.ruleActionMask[r]
				capSum = min(p.totalDemand, capSum+p.effCap(r))
			}
			if !cheap || cover&p.demandMask != p.demandMask || capSum < p.totalDemand {
				return
			}
			flowCalls++
			if flowCalls > maxVerifyFlowCalls {
				v.Completed = false
				return
			}
			if !p.subsetOK(sel) {
				return
			}
			v.FeasibleSubsets++
			ids := p.sortedIDs(sel)
			if !found || cost < bestCost || (cost == bestCost && lessIDs(ids, bestIDs)) {
				found, bestCost, bestIDs = true, cost, ids
			}
			return
		}
		bit := uint64(1) << uint(p.elig[pos])
		rec(pos+1, cost+p.spec.Rules[p.elig[pos]].Cost, sel|bit)
		rec(pos+1, cost, sel)
	}
	rec(0, 0, 0)

	if found {
		c := bestCost
		v.OptimalCost = &c
		v.OptimalRules = bestIDs
	}
	if v.Completed {
		if sol.Feasible != found {
			v.MatchesSolver = false
		} else if !found {
			v.MatchesSolver = true
		} else {
			v.MatchesSolver = sol.Cost == bestCost && equalStrings(p.sortedIDsOfSolution(sol), bestIDs)
		}
	}
	return v
}

func (p *prepared) sortedIDsOfSolution(sol *Solution) []string {
	var ids []string
	for _, r := range sol.Rules {
		ids = append(ids, p.spec.Rules[r].ID)
	}
	sort.Strings(ids)
	return ids
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// AssignmentVerification reports the brute-force assignment enumeration check
// over the solver's chosen subset.
type AssignmentVerification struct {
	Skipped               bool   `json:"skipped"`
	Reason                string `json:"reason,omitempty"`
	Units                 int    `json:"units"`
	FeasibleAssignments   uint64 `json:"feasibleAssignments"`
	CountCapped           bool   `json:"countCapped"`
	FlowSaysFeasible      bool   `json:"flowSaysFeasible"`
	Consistent            bool   `json:"consistent"`
	SolverAssignmentValid bool   `json:"solverAssignmentValid"`
}

// verifyAssignments enumerates every assignment of demand units to the
// selected rules (small instances only) and confirms the flow-based
// feasibility verdict. It also validates the solver's concrete assignment.
func (p *prepared) verifyAssignments(sol *Solution) AssignmentVerification {
	v := AssignmentVerification{Units: p.totalDemand}
	if !sol.Feasible {
		v.Skipped = true
		v.Reason = "no feasible selection"
		v.Consistent = true
		v.SolverAssignmentValid = true
		return v
	}
	v.SolverAssignmentValid = p.assignmentValid(sol)
	if p.totalDemand > maxAssignEnumUnits {
		v.Skipped = true
		v.Reason = "demand too large for enumeration"
		v.Consistent = true
		return v
	}
	v.FlowSaysFeasible = true

	// Expand the demand multiset into units (action indices).
	var units []int
	for i, a := range p.demandActions {
		for k := 0; k < p.demandCounts[i]; k++ {
			units = append(units, a)
		}
	}
	remaining := make([]int, len(sol.Rules))
	covering := make([][]int, len(units))
	for i, a := range units {
		for j, r := range sol.Rules {
			if p.ruleActionMask[r]&(1<<uint(a)) != 0 {
				covering[i] = append(covering[i], j)
			}
		}
	}
	for j, r := range sol.Rules {
		remaining[j] = p.effCap(r)
	}
	nodes := 0
	var rec func(i int) bool // returns false to abort (budget)
	rec = func(i int) bool {
		nodes++
		if nodes > maxAssignEnumNodes || v.FeasibleAssignments >= maxAssignEnumCount {
			return false
		}
		if i == len(units) {
			v.FeasibleAssignments++
			return true
		}
		for _, j := range covering[i] {
			if remaining[j] > 0 {
				remaining[j]--
				if !rec(i + 1) {
					return false
				}
				remaining[j]++
			}
		}
		return true
	}
	completed := rec(0)
	if !completed {
		v.Skipped = true
		v.Reason = "enumeration budget exhausted"
		v.CountCapped = v.FeasibleAssignments >= maxAssignEnumCount
		v.Consistent = true
		return v
	}
	v.Consistent = (v.FeasibleAssignments > 0) == v.FlowSaysFeasible
	return v
}

// assignmentValid checks the solver's concrete assignment against demands,
// rule coverage, and capacities.
func (p *prepared) assignmentValid(sol *Solution) bool {
	got := map[int]int{}
	usage := map[int]int{}
	for r, per := range sol.Assign {
		selected := false
		for _, sr := range sol.Rules {
			if sr == r {
				selected = true
				break
			}
		}
		if !selected {
			return false
		}
		for a, n := range per {
			if n <= 0 || p.ruleActionMask[r]&(1<<uint(a)) == 0 {
				return false
			}
			got[a] += n
			usage[r] += n
		}
	}
	for i, a := range p.demandActions {
		if got[a] != p.demandCounts[i] {
			return false
		}
	}
	for r, u := range usage {
		if c := p.spec.Rules[r].Capacity; c > 0 && u > c {
			return false
		}
	}
	return true
}
