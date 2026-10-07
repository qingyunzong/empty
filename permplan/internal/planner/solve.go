package planner

import (
	"math"
	"sort"
)

// Assignment records units of one action served by one rule.
type Assignment struct {
	Rule   string `json:"rule"`
	Action string `json:"action"`
	Count  int    `json:"count"`
}

// Solution is a full plan: selected rules plus the demand assignment.
type Solution struct {
	Rules       []string     `json:"rules"` // sorted selected rule IDs
	Assignments []Assignment `json:"assignments"`
	FixedCost   int64        `json:"fixed_cost"`
	UseCost     int64        `json:"use_cost"`
	Cost        int64        `json:"cost"`
}

// instance is the preprocessed, solver-ready form of an Input.
type instance struct {
	in        *Input
	rules     []Rule           // selectable rules only
	excluded  []ExcludedRule   // rules rejected by the forbidden-action filter
	actions   []string         // sorted demanded actions
	demand    []int            // demand[i] = units of actions[i]
	total     int              // total demanded units
	quota     int              // effective quota (>= total if unlimited)
	prereqMask []uint32        // prereqMask[i] = bitmask of rules i requires
	mutexMask  []uint32        // mutexMask[i] = bitmask of rules conflicting with i
}

// ExcludedRule records a rule rejected before optimization and why.
type ExcludedRule struct {
	Rule             string   `json:"rule"`
	ForbiddenActions []string `json:"forbidden_actions,omitempty"`
	Reason           string   `json:"reason"`
}

func prepare(in *Input) *instance {
	inst := &instance{in: in, total: in.TotalDemand()}
	inst.quota = in.Quota
	if inst.quota <= 0 || inst.quota > inst.total {
		inst.quota = inst.total // unlimited or loose quota binds at total demand
	}
	inst.actions = sortedKeys(in.Demands)
	inst.demand = make([]int, len(inst.actions))
	for i, a := range inst.actions {
		inst.demand[i] = in.Demands[a]
	}

	forbidden := map[string]bool{}
	for _, a := range in.Forbidden {
		forbidden[a] = true
	}
	// Pass 1: drop rules covering forbidden actions.
	var kept []Rule
	for _, r := range in.Rules {
		var bad []string
		for _, a := range sortedKeys(r.Actions) {
			if forbidden[a] {
				bad = append(bad, a)
			}
		}
		if len(bad) > 0 {
			inst.excluded = append(inst.excluded, ExcludedRule{
				Rule: r.ID, ForbiddenActions: bad,
				Reason: "covers forbidden action",
			})
			continue
		}
		kept = append(kept, r)
	}
	// Pass 2: drop rules whose prerequisite chain hits a dropped rule.
	keptSet := map[string]bool{}
	for _, r := range kept {
		keptSet[r.ID] = true
	}
	changed := true
	for changed {
		changed = false
		requires := map[string][]string{}
		for _, p := range in.Prereqs {
			requires[p.Rule] = append(requires[p.Rule], p.Requires)
		}
		var next []Rule
		for _, r := range kept {
			ok := true
			for _, req := range requires[r.ID] {
				if !keptSet[req] {
					ok = false
					inst.excluded = append(inst.excluded, ExcludedRule{
						Rule:   r.ID,
						Reason: "requires excluded rule " + req,
					})
					delete(keptSet, r.ID)
					changed = true
					break
				}
			}
			if ok {
				next = append(next, r)
			}
		}
		kept = next
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].ID < kept[j].ID })
	sort.Slice(inst.excluded, func(i, j int) bool { return inst.excluded[i].Rule < inst.excluded[j].Rule })
	inst.rules = kept

	idx := map[string]int{}
	for i, r := range kept {
		idx[r.ID] = i
	}
	n := len(kept)
	inst.prereqMask = make([]uint32, n)
	inst.mutexMask = make([]uint32, n)
	for _, p := range in.Prereqs {
		if i, ok := idx[p.Rule]; ok {
			if j, ok2 := idx[p.Requires]; ok2 {
				inst.prereqMask[i] |= 1 << uint(j)
			}
		}
	}
	for _, p := range in.Mutex {
		i, ok1 := idx[p[0]]
		j, ok2 := idx[p[1]]
		if ok1 && ok2 {
			inst.mutexMask[i] |= 1 << uint(j)
			inst.mutexMask[j] |= 1 << uint(i)
		}
	}
	return inst
}

// effCap returns the effective capacity of rule i.
func (inst *instance) effCap(i int) int {
	c := inst.rules[i].Capacity
	if c <= 0 || c > inst.total {
		return inst.total
	}
	return c
}

// maskValid reports whether the selection bitmask satisfies all
// prerequisite and mutual-exclusion constraints.
func (inst *instance) maskValid(mask uint32) bool {
	for i := range inst.rules {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		if inst.prereqMask[i]&^mask != 0 {
			return false
		}
		if inst.mutexMask[i]&mask != 0 {
			return false
		}
	}
	return true
}

// coverPossible is a cheap necessary-condition precheck for a mask.
// scratch must have len >= len(inst.actions).
func (inst *instance) coverPossible(mask uint32, scratch []int) bool {
	capSum := 0
	for i := range inst.rules {
		if mask&(1<<uint(i)) != 0 {
			capSum += inst.effCap(i)
		}
	}
	if capSum < inst.total {
		return false
	}
	avail := scratch[:len(inst.actions)]
	for j := range avail {
		avail[j] = 0
	}
	for i := range inst.rules {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		for j, a := range inst.actions {
			avail[j] += inst.rules[i].Actions[a]
		}
	}
	for j := range inst.actions {
		if avail[j] < inst.demand[j] {
			return false
		}
	}
	return true
}

// assign runs min-cost flow for a mask and returns the assignment cost
// and the assignment itself. ok is false when the mask cannot cover demand.
func (inst *instance) assign(mask uint32) (useCost int64, asgn []Assignment, ok bool) {
	na := len(inst.actions)
	var selIdx []int
	for i := range inst.rules {
		if mask&(1<<uint(i)) != 0 {
			selIdx = append(selIdx, i)
		}
	}
	// Node layout: 0=source, 1..na=actions, then rules, then quota, then sink.
	src := 0
	ruleBase := 1 + na
	quotaNode := ruleBase + len(selIdx)
	sink := quotaNode + 1
	fg := newFlowGraph(sink + 1)
	for j := range inst.actions {
		fg.addEdge(src, 1+j, inst.demand[j], 0)
	}
	type edgeRef struct{ node, idx, rule, action int }
	var refs []edgeRef
	for k, i := range selIdx {
		rn := ruleBase + k
		for j, a := range inst.actions {
			lim := inst.rules[i].Actions[a]
			if lim <= 0 {
				continue
			}
			if lim > inst.demand[j] {
				lim = inst.demand[j]
			}
			fg.addEdge(1+j, rn, lim, inst.rules[i].UseCost)
			refs = append(refs, edgeRef{1 + j, len(fg.g[1+j]) - 1, i, j})
		}
		fg.addEdge(rn, quotaNode, inst.effCap(i), 0)
	}
	fg.addEdge(quotaNode, sink, inst.quota, 0)
	flow, cost := fg.minCostFlow(src, sink, inst.total)
	if flow < inst.total {
		return 0, nil, false
	}
	for _, r := range refs {
		if u := fg.usedFlow(r.node, r.idx); u > 0 {
			asgn = append(asgn, Assignment{
				Rule:   inst.rules[r.rule].ID,
				Action: inst.actions[r.action],
				Count:  u,
			})
		}
	}
	sort.Slice(asgn, func(i, j int) bool {
		if asgn[i].Rule != asgn[j].Rule {
			return asgn[i].Rule < asgn[j].Rule
		}
		return asgn[i].Action < asgn[j].Action
	})
	return cost, asgn, true
}

// better reports whether candidate a beats incumbent b:
// lower cost first, ties broken by lexicographic rule-ID order.
func better(a, b *Solution) bool {
	if b == nil {
		return true
	}
	if a.Cost != b.Cost {
		return a.Cost < b.Cost
	}
	for i := 0; i < len(a.Rules) && i < len(b.Rules); i++ {
		if a.Rules[i] != b.Rules[i] {
			return a.Rules[i] < b.Rules[i]
		}
	}
	return len(a.Rules) < len(b.Rules)
}

func (inst *instance) solutionFor(mask uint32) *Solution {
	useCost, asgn, ok := inst.assign(mask)
	if !ok {
		return nil
	}
	var fixed int64
	var ids []string
	for i, r := range inst.rules {
		if mask&(1<<uint(i)) != 0 {
			fixed += r.Cost
			ids = append(ids, r.ID)
		}
	}
	return &Solution{
		Rules: ids, Assignments: asgn,
		FixedCost: fixed, UseCost: useCost, Cost: fixed + useCost,
	}
}

// Solve finds the minimum-cost plan by exhaustive subset enumeration
// (n <= 22) with constraint and cost pruning plus min-cost-flow
// assignment. Returns nil when the instance is infeasible.
func Solve(in *Input) (*Solution, *instance) {
	inst := prepare(in)
	if inst.total == 0 {
		return &Solution{}, inst
	}
	n := len(inst.rules)
	if n == 0 || inst.total > inst.quota {
		return nil, inst
	}
	// Seed the incumbent with the greedy feasible plan for pruning.
	var best *Solution
	if mask, ok := inst.greedyMask(); ok {
		best = inst.solutionFor(mask)
	}
	// use[i][j] = use cost of rule i for action j, or -1 when rule i
	// cannot serve action j. Used for the lower-bound cost prune.
	use := make([][]int64, n)
	for i := range inst.rules {
		use[i] = make([]int64, len(inst.actions))
		for j, a := range inst.actions {
			if inst.rules[i].Actions[a] > 0 {
				use[i][j] = inst.rules[i].UseCost
			} else {
				use[i][j] = -1
			}
		}
	}
	// fixed[mask] = sum of fixed costs in mask, built by lowbit DP.
	size := uint32(1) << uint(n)
	fixed := make([]int64, size)
	scratch := make([]int, len(inst.actions))
	for mask := uint32(1); mask < size; mask++ {
		lb := mask & (-mask)
		i := bitIndex(lb)
		fixed[mask] = fixed[mask^lb] + inst.rules[i].Cost
		// Cost prune: lower-bound the total cost of any plan using
		// exactly this mask by its fixed part plus the cheapest
		// possible use cost per demanded unit. A mask whose bound
		// exceeds the incumbent can never win, even on the ID-order
		// tie-break.
		if best != nil {
			bound := fixed[mask]
			for j := range inst.actions {
				minUse := int64(-1)
				for i := range inst.rules {
					if mask&(1<<uint(i)) != 0 && use[i][j] >= 0 &&
						(minUse < 0 || use[i][j] < minUse) {
						minUse = use[i][j]
					}
				}
				if minUse > 0 {
					bound += minUse * int64(inst.demand[j])
				}
			}
			if bound > best.Cost {
				continue
			}
		}
		if !inst.maskValid(mask) || !inst.coverPossible(mask, scratch) {
			continue
		}
		if s := inst.solutionFor(mask); s != nil && better(s, best) {
			best = s
		}
	}
	return best, inst
}

// bitIndex returns the index of the single set bit in v.
func bitIndex(v uint32) int {
	i := 0
	for v > 1 {
		v >>= 1
		i++
	}
	return i
}

// noSolution is a sentinel cost for infeasible instances.
const noSolution int64 = math.MaxInt64
