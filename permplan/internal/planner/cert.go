package planner

import "fmt"

// Certificate is the full machine-checkable output of a solve run.
type Certificate struct {
	Status      string           `json:"status"` // "optimal" or "infeasible"
	Solution    *Solution        `json:"solution,omitempty"`
	RuleUsage   []RuleUsage      `json:"rule_usage,omitempty"`
	Coverage    []CoverageEntry  `json:"coverage"`
	Forbidden   []ExcludedRule   `json:"forbidden_check"`
	Deps        DependencyCert   `json:"dependency_check"`
	Quota       QuotaCert        `json:"quota_check"`
	Bounds      Bounds           `json:"bounds"`
	Verify      VerificationCert `json:"verification"`
}

// RuleUsage is the per-rule usage breakdown.
type RuleUsage struct {
	Rule  string         `json:"rule"`
	Uses  map[string]int `json:"uses"`
	Total int            `json:"total"`
}

// CoverageEntry shows how one demanded action is covered.
type CoverageEntry struct {
	Action   string `json:"action"`
	Demanded int    `json:"demanded"`
	Assigned int    `json:"assigned"`
	OK       bool   `json:"ok"`
}

// DependencyCert certifies prerequisite and mutex compliance.
type DependencyCert struct {
	Prereqs []PrereqCheck `json:"prereqs"`
	Mutex   []MutexCheck  `json:"mutex"`
	OK      bool          `json:"ok"`
}

// PrereqCheck records one prerequisite edge evaluation.
type PrereqCheck struct {
	Rule      string `json:"rule"`
	Requires  string `json:"requires"`
	RuleIn    bool   `json:"rule_selected"`
	RequiresIn bool  `json:"requires_selected"`
	OK        bool   `json:"ok"`
}

// MutexCheck records one mutual-exclusion pair evaluation.
type MutexCheck struct {
	A  string `json:"a"`
	B  string `json:"b"`
	AIn bool  `json:"a_selected"`
	BIn bool  `json:"b_selected"`
	OK bool   `json:"ok"`
}

// QuotaCert certifies the global action-count quota.
type QuotaCert struct {
	Limit int  `json:"limit"` // effective limit; 0 means unlimited in input
	Used  int  `json:"used"`
	OK    bool `json:"ok"`
}

// VerificationCert reports the independent brute-force cross-checks.
type VerificationCert struct {
	Ran                 bool   `json:"ran"`
	SubsetEnumCost      int64  `json:"subset_enum_cost"`      // optimum per subset enumeration + assignment enumeration
	SubsetEnumMatch     bool   `json:"subset_enum_match"`     // solver cost agrees with brute force
	AssignmentEnumMatch bool   `json:"assignment_enum_match"` // per-selected-set assignment cost agrees
	Note                string `json:"note,omitempty"`
}

// enumVerifyLimit caps rules*demand work for the in-certificate
// brute-force cross-check so the CLI stays fast.
const enumVerifyLimit = 16

// BuildCertificate solves the instance and assembles the certificate.
func BuildCertificate(in *Input) (*Certificate, error) {
	if err := in.Validate(); err != nil {
		return nil, err
	}
	sol, inst := Solve(in)
	cert := &Certificate{
		Forbidden: inst.excluded,
		Bounds:    ComputeBounds(in),
	}
	if cert.Forbidden == nil {
		cert.Forbidden = []ExcludedRule{}
	}
	// Coverage + quota certificates are meaningful even when infeasible.
	assigned := map[string]int{}
	used := 0
	if sol != nil {
		for _, a := range sol.Assignments {
			assigned[a.Action] += a.Count
			used += a.Count
		}
	}
	for _, a := range inst.actions {
		cert.Coverage = append(cert.Coverage, CoverageEntry{
			Action:   a,
			Demanded: in.Demands[a],
			Assigned: assigned[a],
			OK:       assigned[a] == in.Demands[a],
		})
	}
	if cert.Coverage == nil {
		cert.Coverage = []CoverageEntry{}
	}
	cert.Quota = QuotaCert{Limit: in.Quota, Used: used, OK: in.Quota <= 0 || used <= in.Quota}

	if sol == nil {
		cert.Status = "infeasible"
	} else {
		cert.Status = "optimal"
		cert.Solution = sol
		cert.RuleUsage = ruleUsage(sol)
	}
	cert.Deps = buildDepCert(in, sol)
	cert.Verify = crossCheck(in, inst, sol)
	return cert, nil
}

func ruleUsage(sol *Solution) []RuleUsage {
	byRule := map[string]map[string]int{}
	for _, a := range sol.Assignments {
		m := byRule[a.Rule]
		if m == nil {
			m = map[string]int{}
			byRule[a.Rule] = m
		}
		m[a.Action] += a.Count
	}
	var out []RuleUsage
	for _, id := range sol.Rules {
		uses := byRule[id]
		if uses == nil {
			uses = map[string]int{}
		}
		t := 0
		for _, n := range uses {
			t += n
		}
		out = append(out, RuleUsage{Rule: id, Uses: uses, Total: t})
	}
	return out
}

func buildDepCert(in *Input, sol *Solution) DependencyCert {
	selected := map[string]bool{}
	if sol != nil {
		for _, id := range sol.Rules {
			selected[id] = true
		}
	}
	dc := DependencyCert{OK: true}
	for _, p := range in.Prereqs {
		chk := PrereqCheck{
			Rule: p.Rule, Requires: p.Requires,
			RuleIn: selected[p.Rule], RequiresIn: selected[p.Requires],
		}
		chk.OK = !chk.RuleIn || chk.RequiresIn
		if !chk.OK {
			dc.OK = false
		}
		dc.Prereqs = append(dc.Prereqs, chk)
	}
	if dc.Prereqs == nil {
		dc.Prereqs = []PrereqCheck{}
	}
	for _, m := range in.Mutex {
		chk := MutexCheck{A: m[0], B: m[1], AIn: selected[m[0]], BIn: selected[m[1]]}
		chk.OK = !(chk.AIn && chk.BIn)
		if !chk.OK {
			dc.OK = false
		}
		dc.Mutex = append(dc.Mutex, chk)
	}
	if dc.Mutex == nil {
		dc.Mutex = []MutexCheck{}
	}
	return dc
}

// crossCheck runs the independent brute force when the instance is
// small enough and compares results.
func crossCheck(in *Input, inst *instance, sol *Solution) VerificationCert {
	v := VerificationCert{}
	if len(inst.rules) > enumVerifyLimit || inst.total > enumVerifyLimit {
		v.Note = fmt.Sprintf("skipped: %d rules / %d demand units exceed enumeration limit %d",
			len(inst.rules), inst.total, enumVerifyLimit)
		return v
	}
	v.Ran = true
	cost, _ := BruteForce(in)
	if cost == noSolution {
		v.SubsetEnumCost = -1
		v.SubsetEnumMatch = sol == nil
	} else {
		v.SubsetEnumCost = cost
		v.SubsetEnumMatch = sol != nil && sol.Cost == cost
	}
	// Assignment-level acceptance: for the solver's chosen rule set,
	// the unit-by-unit assignment enumeration must reproduce the same
	// use cost.
	if sol != nil {
		selSet := map[string]bool{}
		for _, id := range sol.Rules {
			selSet[id] = true
		}
		var sel []int
		for i, r := range inst.rules {
			if selSet[r.ID] {
				sel = append(sel, i)
			}
		}
		if uc, ok := inst.bruteAssign(sel); ok {
			v.AssignmentEnumMatch = uc == sol.UseCost
		}
	} else {
		v.AssignmentEnumMatch = true
	}
	return v
}

// CheckCertificate independently validates a certificate against the
// input: coverage, forbidden filter, dependencies, quota, per-rule
// limits, and reported cost. It does not re-prove optimality beyond
// the embedded enumeration cross-check flags.
func CheckCertificate(in *Input, c *Certificate) []string {
	var problems []string
	if err := in.Validate(); err != nil {
		return []string{"invalid input: " + err.Error()}
	}
	_, inst := Solve(in) // re-derive preprocessing (excluded rules)
	// Forbidden check: listed exclusions must match the recomputed ones.
	want := map[string]string{}
	for _, e := range inst.excluded {
		want[e.Rule] = e.Reason
	}
	got := map[string]bool{}
	for _, e := range c.Forbidden {
		got[e.Rule] = true
		if _, ok := want[e.Rule]; !ok {
			problems = append(problems, "forbidden_check: unexpected exclusion of "+e.Rule)
		}
	}
	for id := range want {
		if !got[id] {
			problems = append(problems, "forbidden_check: missing exclusion of "+id)
		}
	}
	if c.Status == "infeasible" {
		if c.Solution != nil {
			problems = append(problems, "infeasible certificate carries a solution")
		}
		return problems
	}
	if c.Solution == nil {
		return append(problems, "optimal certificate lacks a solution")
	}
	sol := c.Solution
	// Recompute cost from scratch.
	ruleByID := map[string]Rule{}
	for _, r := range in.Rules {
		ruleByID[r.ID] = r
	}
	selected := map[string]bool{}
	var fixed int64
	for _, id := range sol.Rules {
		r, ok := ruleByID[id]
		if !ok {
			problems = append(problems, "solution selects unknown rule "+id)
			continue
		}
		if _, excluded := want[id]; excluded {
			problems = append(problems, "solution selects excluded rule "+id)
		}
		selected[id] = true
		fixed += r.Cost
	}
	// Dependencies.
	for _, p := range in.Prereqs {
		if selected[p.Rule] && !selected[p.Requires] {
			problems = append(problems, fmt.Sprintf("prereq violated: %s requires %s", p.Rule, p.Requires))
		}
	}
	for _, m := range in.Mutex {
		if selected[m[0]] && selected[m[1]] {
			problems = append(problems, fmt.Sprintf("mutex violated: %s and %s both selected", m[0], m[1]))
		}
	}
	// Assignments: per-action limits, capacities, coverage, use cost.
	usedByRule := map[string]int{}
	usedByRuleAction := map[string]map[string]int{}
	covered := map[string]int{}
	var useCost int64
	for _, a := range sol.Assignments {
		r, ok := ruleByID[a.Rule]
		if !ok || !selected[a.Rule] {
			problems = append(problems, "assignment to unselected rule "+a.Rule)
			continue
		}
		if a.Count <= 0 {
			problems = append(problems, "non-positive assignment on rule " + a.Rule)
		}
		m := usedByRuleAction[a.Rule]
		if m == nil {
			m = map[string]int{}
			usedByRuleAction[a.Rule] = m
		}
		m[a.Action] += a.Count
		if m[a.Action] > r.Actions[a.Action] {
			problems = append(problems, fmt.Sprintf("rule %s exceeds limit for action %s", a.Rule, a.Action))
		}
		usedByRule[a.Rule] += a.Count
		covered[a.Action] += a.Count
		useCost += int64(a.Count) * r.UseCost
	}
	for id, n := range usedByRule {
		r := ruleByID[id]
		if r.Capacity > 0 && n > r.Capacity {
			problems = append(problems, fmt.Sprintf("rule %s exceeds capacity", id))
		}
	}
	for act, d := range in.Demands {
		if covered[act] != d {
			problems = append(problems, fmt.Sprintf("demand %s: covered %d != demanded %d", act, covered[act], d))
		}
	}
	if in.Quota > 0 && sol != nil {
		total := 0
		for _, n := range covered {
			total += n
		}
		if total > in.Quota {
			problems = append(problems, "global quota exceeded")
		}
	}
	if fixed != sol.FixedCost {
		problems = append(problems, "fixed cost mismatch")
	}
	if useCost != sol.UseCost {
		problems = append(problems, "use cost mismatch")
	}
	if fixed+useCost != sol.Cost {
		problems = append(problems, "total cost mismatch")
	}
	// Bounds sanity.
	if c.Bounds.UpperOK && sol.Cost > c.Bounds.Upper {
		problems = append(problems, "solution cost exceeds certified upper bound")
	}
	if c.Bounds.Lower != noSolution && sol.Cost < c.Bounds.Lower {
		problems = append(problems, "solution cost below certified lower bound")
	}
	return problems
}
