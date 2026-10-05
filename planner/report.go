package planner

import "sort"

// Report is the full planning output: selection, assignments, certificates,
// bounds, and independent verification results.
type Report struct {
	Status        string            `json:"status"` // "optimal" or "infeasible"
	Cost          *int64            `json:"cost,omitempty"`
	SelectedRules []string          `json:"selectedRules"`
	Assignments   []AssignmentEntry `json:"assignments"`
	RuleUsage     []RuleUsageEntry  `json:"ruleUsage"`
	Certificates  Certificates      `json:"certificates"`
	Bounds        Bounds            `json:"bounds"`
	Verification  Verification      `json:"verification"`
}

// AssignmentEntry records how many units of an action a rule serves.
type AssignmentEntry struct {
	Action string `json:"action"`
	Rule   string `json:"rule"`
	Count  int    `json:"count"`
}

// RuleUsageEntry records total assigned units for a selected rule.
type RuleUsageEntry struct {
	Rule     string `json:"rule"`
	Used     int    `json:"used"`
	Capacity int    `json:"capacity"` // 0 = unlimited
}

// Certificates groups the machine-checkable proof artifacts.
type Certificates struct {
	Forbidden    []ForbiddenCert  `json:"forbidden"`
	Coverage     []CoverageCert   `json:"coverage"`
	Dependencies []DependencyCert `json:"dependencies"`
	Exclusions   []ExclusionCert  `json:"exclusions"`
	Quota        QuotaCert        `json:"quota"`
	Capacities   []CapacityCert   `json:"capacities"`
}

// ForbiddenCert shows, per rule, which forbidden actions it covers and
// whether it was rejected from selection eligibility.
type ForbiddenCert struct {
	Rule             string   `json:"rule"`
	ForbiddenActions []string `json:"forbiddenActions"`
	Rejected         bool     `json:"rejected"`
	Selected         bool     `json:"selected"`
}

// CoverageCert shows, per demand action, demand vs assigned units.
type CoverageCert struct {
	Action   string         `json:"action"`
	Demand   int            `json:"demand"`
	Assigned int            `json:"assigned"`
	ByRule   map[string]int `json:"byRule"`
	OK       bool           `json:"ok"`
}

// DependencyCert shows, per selected rule, that its prerequisites hold.
type DependencyCert struct {
	Rule      string   `json:"rule"`
	Requires  []string `json:"requires"`
	Missing   []string `json:"missing"`
	Satisfied bool     `json:"satisfied"`
}

// ExclusionCert shows, per declared mutex pair, that both are not selected.
type ExclusionCert struct {
	A            string `json:"a"`
	B            string `json:"b"`
	BothSelected bool   `json:"bothSelected"`
}

// QuotaCert shows global action-count quota usage.
type QuotaCert struct {
	Used      int  `json:"used"`
	Limit     int  `json:"limit"` // 0 = unlimited
	Unlimited bool `json:"unlimited"`
	OK        bool `json:"ok"`
}

// CapacityCert shows per-rule capacity usage for selected rules.
type CapacityCert struct {
	Rule      string `json:"rule"`
	Used      int    `json:"used"`
	Capacity  int    `json:"capacity"` // 0 = unlimited
	Unlimited bool   `json:"unlimited"`
	OK        bool   `json:"ok"`
}

// Bounds records the relaxation lower bound, the heuristic upper bound, and
// the exact optimum so budgets can be sanity-checked.
type Bounds struct {
	Lower   int64  `json:"lower"`
	Upper   *int64 `json:"upper"`
	Optimal *int64 `json:"optimal"`
	Note    string `json:"note"`
}

// Verification groups the independent cross-checks.
type Verification struct {
	Subsets     SubsetVerification     `json:"subsets"`
	Assignments AssignmentVerification `json:"assignments"`
}

// Plan validates the spec, solves it, and assembles the full report.
func Plan(spec *Spec) (*Report, error) {
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	p := prepare(spec)
	sol := p.solve()
	rep := &Report{SelectedRules: []string{}, Assignments: []AssignmentEntry{}, RuleUsage: []RuleUsageEntry{}}
	if sol.Feasible {
		rep.Status = "optimal"
		c := sol.Cost
		rep.Cost = &c
		ids := p.sortedIDsOfSolution(sol)
		rep.SelectedRules = ids
		rep.Assignments = buildAssignments(p, sol)
		rep.RuleUsage = buildRuleUsage(p, sol)
	} else {
		rep.Status = "infeasible"
	}
	rep.Certificates = buildCertificates(p, sol)
	rep.Bounds = buildBounds(p, sol)
	rep.Verification = Verification{
		Subsets:     p.verifySubsets(sol),
		Assignments: p.verifyAssignments(sol),
	}
	return rep, nil
}

func buildAssignments(p *prepared, sol *Solution) []AssignmentEntry {
	var out []AssignmentEntry
	for r, per := range sol.Assign {
		for a, n := range per {
			out = append(out, AssignmentEntry{
				Action: p.actions[a],
				Rule:   p.spec.Rules[r].ID,
				Count:  n,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Action != out[j].Action {
			return out[i].Action < out[j].Action
		}
		return out[i].Rule < out[j].Rule
	})
	if out == nil {
		out = []AssignmentEntry{}
	}
	return out
}

func buildRuleUsage(p *prepared, sol *Solution) []RuleUsageEntry {
	usage := sol.RuleUsage()
	out := make([]RuleUsageEntry, 0, len(sol.Rules))
	for _, r := range sol.Rules {
		out = append(out, RuleUsageEntry{
			Rule:     p.spec.Rules[r].ID,
			Used:     usage[r],
			Capacity: p.spec.Rules[r].Capacity,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Rule < out[j].Rule })
	return out
}

func buildCertificates(p *prepared, sol *Solution) Certificates {
	certs := Certificates{
		Forbidden:    []ForbiddenCert{},
		Coverage:     []CoverageCert{},
		Dependencies: []DependencyCert{},
		Exclusions:   []ExclusionCert{},
		Capacities:   []CapacityCert{},
	}
	selected := map[int]bool{}
	for _, r := range sol.Rules {
		selected[r] = true
	}

	for i, rule := range p.spec.Rules {
		hits := p.forbiddenHits[i]
		if hits == nil {
			hits = []string{}
		}
		certs.Forbidden = append(certs.Forbidden, ForbiddenCert{
			Rule:             rule.ID,
			ForbiddenActions: hits,
			Rejected:         !p.eligible[i],
			Selected:         selected[i],
		})
	}

	for i, a := range p.demandActions {
		cc := CoverageCert{
			Action: p.actions[a],
			Demand: p.demandCounts[i],
			ByRule: map[string]int{},
		}
		if sol.Feasible {
			for _, r := range sol.Rules {
				if n := sol.Assign[r][a]; n > 0 {
					cc.ByRule[p.spec.Rules[r].ID] = n
					cc.Assigned += n
				}
			}
		}
		cc.OK = cc.Assigned == cc.Demand
		certs.Coverage = append(certs.Coverage, cc)
	}

	for _, r := range sol.Rules {
		dc := DependencyCert{Rule: p.spec.Rules[r].ID, Requires: []string{}, Missing: []string{}}
		for _, dep := range p.spec.Rules[r].Requires {
			dc.Requires = append(dc.Requires, dep)
			if !selected[p.ruleIdx[dep]] {
				dc.Missing = append(dc.Missing, dep)
			}
		}
		sort.Strings(dc.Requires)
		sort.Strings(dc.Missing)
		dc.Satisfied = len(dc.Missing) == 0
		certs.Dependencies = append(certs.Dependencies, dc)
	}
	sort.Slice(certs.Dependencies, func(i, j int) bool {
		return certs.Dependencies[i].Rule < certs.Dependencies[j].Rule
	})

	seen := map[[2]string]bool{}
	for _, rule := range p.spec.Rules {
		for _, ex := range rule.Excludes {
			pair := [2]string{rule.ID, ex}
			if pair[0] > pair[1] {
				pair[0], pair[1] = pair[1], pair[0]
			}
			if seen[pair] {
				continue
			}
			seen[pair] = true
			certs.Exclusions = append(certs.Exclusions, ExclusionCert{
				A:            pair[0],
				B:            pair[1],
				BothSelected: selected[p.ruleIdx[pair[0]]] && selected[p.ruleIdx[pair[1]]],
			})
		}
	}
	sort.Slice(certs.Exclusions, func(i, j int) bool {
		if certs.Exclusions[i].A != certs.Exclusions[j].A {
			return certs.Exclusions[i].A < certs.Exclusions[j].A
		}
		return certs.Exclusions[i].B < certs.Exclusions[j].B
	})

	q := p.spec.GlobalQuota
	certs.Quota = QuotaCert{
		Used:      p.totalDemand,
		Limit:     q,
		Unlimited: q <= 0,
		OK:        q <= 0 || p.totalDemand <= q,
	}

	usage := sol.RuleUsage()
	for _, r := range sol.Rules {
		c := p.spec.Rules[r].Capacity
		certs.Capacities = append(certs.Capacities, CapacityCert{
			Rule:      p.spec.Rules[r].ID,
			Used:      usage[r],
			Capacity:  c,
			Unlimited: c <= 0,
			OK:        c <= 0 || usage[r] <= c,
		})
	}
	sort.Slice(certs.Capacities, func(i, j int) bool {
		return certs.Capacities[i].Rule < certs.Capacities[j].Rule
	})
	return certs
}

func buildBounds(p *prepared, sol *Solution) Bounds {
	b := Bounds{Lower: p.lowerBound(), Upper: p.greedyUpperBound()}
	if sol.Feasible {
		c := sol.Cost
		b.Optimal = &c
		b.Note = "lower <= optimal <= upper verified by exact branch-and-bound plus full subset enumeration"
	} else {
		b.Note = "no feasible selection; bounds are relaxation/heuristic only"
	}
	return b
}
