package planner

import (
	"math/rand"
	"testing"
)

func planOrFail(t *testing.T, spec *Spec) *Report {
	t.Helper()
	rep, err := Plan(spec)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	return rep
}

func mustOptimal(t *testing.T, rep *Report, cost int64, rules ...string) {
	t.Helper()
	if rep.Status != "optimal" {
		t.Fatalf("status = %s, want optimal", rep.Status)
	}
	if rep.Cost == nil || *rep.Cost != cost {
		t.Fatalf("cost = %v, want %d", rep.Cost, cost)
	}
	if len(rep.SelectedRules) != len(rules) {
		t.Fatalf("selected = %v, want %v", rep.SelectedRules, rules)
	}
	for i := range rules {
		if rep.SelectedRules[i] != rules[i] {
			t.Fatalf("selected = %v, want %v", rep.SelectedRules, rules)
		}
	}
}

func checkVerification(t *testing.T, rep *Report) {
	t.Helper()
	if !rep.Verification.Subsets.Completed {
		t.Fatalf("subset enumeration did not complete")
	}
	if !rep.Verification.Subsets.MatchesSolver {
		t.Fatalf("subset enumeration disagrees with solver: %+v", rep.Verification.Subsets)
	}
	if !rep.Verification.Assignments.Consistent {
		t.Fatalf("assignment enumeration inconsistent: %+v", rep.Verification.Assignments)
	}
	if !rep.Verification.Assignments.SolverAssignmentValid {
		t.Fatalf("solver assignment invalid")
	}
	if rep.Bounds.Optimal != nil {
		if rep.Bounds.Lower > *rep.Bounds.Optimal {
			t.Fatalf("lower bound %d exceeds optimum %d", rep.Bounds.Lower, *rep.Bounds.Optimal)
		}
		if rep.Bounds.Upper != nil && *rep.Bounds.Upper < *rep.Bounds.Optimal {
			t.Fatalf("upper bound %d below optimum %d", *rep.Bounds.Upper, *rep.Bounds.Optimal)
		}
	}
}

func TestBasicMinCost(t *testing.T) {
	rep := planOrFail(t, &Spec{
		Rules: []Rule{
			{ID: "r1", Cost: 5, Actions: []string{"read"}},
			{ID: "r2", Cost: 3, Actions: []string{"read", "write"}},
		},
		Demands: map[string]int{"read": 1, "write": 1},
	})
	mustOptimal(t, rep, 3, "r2")
	checkVerification(t, rep)
}

func TestMultisetNotSetCover(t *testing.T) {
	// One rule covering "read" is not enough: demand is 3 units and each
	// cheap rule has capacity 2, so two cheap rules beat one expensive one.
	rep := planOrFail(t, &Spec{
		Rules: []Rule{
			{ID: "ra", Cost: 1, Actions: []string{"read"}, Capacity: 2},
			{ID: "rb", Cost: 1, Actions: []string{"read"}, Capacity: 2},
			{ID: "rc", Cost: 5, Actions: []string{"read"}},
		},
		Demands: map[string]int{"read": 3},
	})
	mustOptimal(t, rep, 2, "ra", "rb")
	checkVerification(t, rep)
	var cov CoverageCert
	for _, c := range rep.Certificates.Coverage {
		if c.Action == "read" {
			cov = c
		}
	}
	if !cov.OK || cov.Assigned != 3 || len(cov.ByRule) != 2 {
		t.Fatalf("coverage cert wrong: %+v", cov)
	}
}

func TestForbiddenRuleRejected(t *testing.T) {
	rep := planOrFail(t, &Spec{
		Rules: []Rule{
			{ID: "cheap-dirty", Cost: 1, Actions: []string{"read", "delete"}},
			{ID: "clean", Cost: 9, Actions: []string{"read"}},
		},
		Forbidden: []string{"delete"},
		Demands:   map[string]int{"read": 1},
	})
	mustOptimal(t, rep, 9, "clean")
	var dirty *ForbiddenCert
	for i := range rep.Certificates.Forbidden {
		if rep.Certificates.Forbidden[i].Rule == "cheap-dirty" {
			dirty = &rep.Certificates.Forbidden[i]
		}
	}
	if dirty == nil || !dirty.Rejected || len(dirty.ForbiddenActions) != 1 || dirty.ForbiddenActions[0] != "delete" {
		t.Fatalf("forbidden cert wrong: %+v", dirty)
	}
	checkVerification(t, rep)
}

func TestMutualExclusion(t *testing.T) {
	rep := planOrFail(t, &Spec{
		Rules: []Rule{
			{ID: "r1", Cost: 1, Actions: []string{"a"}, Excludes: []string{"r2"}},
			{ID: "r2", Cost: 1, Actions: []string{"b"}},
			{ID: "r3", Cost: 5, Actions: []string{"a", "b"}},
		},
		Demands: map[string]int{"a": 1, "b": 1},
	})
	mustOptimal(t, rep, 5, "r3")
	for _, ex := range rep.Certificates.Exclusions {
		if ex.BothSelected {
			t.Fatalf("exclusion violated: %+v", ex)
		}
	}
	checkVerification(t, rep)
}

func TestRequiresPrerequisite(t *testing.T) {
	rep := planOrFail(t, &Spec{
		Rules: []Rule{
			{ID: "r1", Cost: 1, Actions: []string{"a"}, Requires: []string{"r2"}},
			{ID: "r2", Cost: 4, Actions: []string{"z"}},
			{ID: "r3", Cost: 6, Actions: []string{"a"}},
		},
		Demands: map[string]int{"a": 1},
	})
	mustOptimal(t, rep, 5, "r1", "r2")
	var dep *DependencyCert
	for i := range rep.Certificates.Dependencies {
		if rep.Certificates.Dependencies[i].Rule == "r1" {
			dep = &rep.Certificates.Dependencies[i]
		}
	}
	if dep == nil || !dep.Satisfied || len(dep.Requires) != 1 || dep.Requires[0] != "r2" {
		t.Fatalf("dependency cert wrong: %+v", dep)
	}
	checkVerification(t, rep)
}

func TestRequiresIneligibleRuleIsInfeasible(t *testing.T) {
	rep := planOrFail(t, &Spec{
		Rules: []Rule{
			{ID: "r1", Cost: 1, Actions: []string{"a"}, Requires: []string{"r2"}},
			{ID: "r2", Cost: 1, Actions: []string{"z", "secret"}},
		},
		Forbidden: []string{"secret"},
		Demands:   map[string]int{"a": 1},
	})
	if rep.Status != "infeasible" {
		t.Fatalf("status = %s, want infeasible", rep.Status)
	}
	checkVerification(t, rep)
}

func TestGlobalQuota(t *testing.T) {
	rep := planOrFail(t, &Spec{
		Rules:       []Rule{{ID: "r1", Cost: 1, Actions: []string{"a"}}},
		Demands:     map[string]int{"a": 3},
		GlobalQuota: 2,
	})
	if rep.Status != "infeasible" {
		t.Fatalf("status = %s, want infeasible", rep.Status)
	}
	if rep.Certificates.Quota.OK {
		t.Fatalf("quota cert should flag violation: %+v", rep.Certificates.Quota)
	}
	checkVerification(t, rep)
}

func TestTieBreakByIDOrder(t *testing.T) {
	// Equal-cost optima {r1,r2} and {r3}: lexicographic ID order wins.
	rep := planOrFail(t, &Spec{
		Rules: []Rule{
			{ID: "r3", Cost: 2, Actions: []string{"a"}},
			{ID: "r1", Cost: 1, Actions: []string{"a"}, Capacity: 1},
			{ID: "r2", Cost: 1, Actions: []string{"a"}, Capacity: 1},
		},
		Demands: map[string]int{"a": 2},
	})
	mustOptimal(t, rep, 2, "r1", "r2")
	checkVerification(t, rep)
}

func TestInfeasibleUncoverable(t *testing.T) {
	rep := planOrFail(t, &Spec{
		Rules:   []Rule{{ID: "r1", Cost: 1, Actions: []string{"a"}}},
		Demands: map[string]int{"b": 1},
	})
	if rep.Status != "infeasible" {
		t.Fatalf("status = %s, want infeasible", rep.Status)
	}
	checkVerification(t, rep)
}

func TestCapacityForcesAssignmentSpread(t *testing.T) {
	rep := planOrFail(t, &Spec{
		Rules: []Rule{
			{ID: "r1", Cost: 2, Actions: []string{"a", "b"}, Capacity: 1},
			{ID: "r2", Cost: 2, Actions: []string{"a", "b"}, Capacity: 1},
		},
		Demands: map[string]int{"a": 1, "b": 1},
	})
	mustOptimal(t, rep, 4, "r1", "r2")
	usage := map[string]int{}
	for _, u := range rep.RuleUsage {
		usage[u.Rule] = u.Used
	}
	if usage["r1"] != 1 || usage["r2"] != 1 {
		t.Fatalf("usage = %v, want one unit per rule", usage)
	}
	checkVerification(t, rep)
}

func TestValidationErrors(t *testing.T) {
	tooMany := &Spec{}
	for i := 0; i < MaxRules+1; i++ {
		tooMany.Rules = append(tooMany.Rules, Rule{ID: string(rune('a' + i)), Cost: 1, Actions: []string{"a"}})
	}
	if err := tooMany.Validate(); err == nil {
		t.Fatal("expected error for >22 rules")
	}
	if err := (&Spec{Rules: []Rule{
		{ID: "x", Cost: 1, Actions: []string{"a"}},
		{ID: "x", Cost: 1, Actions: []string{"a"}},
	}}).Validate(); err == nil {
		t.Fatal("expected error for duplicate ids")
	}
	if err := (&Spec{Rules: []Rule{
		{ID: "x", Cost: 1, Actions: []string{"a"}, Requires: []string{"ghost"}},
	}}).Validate(); err == nil {
		t.Fatal("expected error for unknown requires")
	}
	if err := (&Spec{Rules: []Rule{
		{ID: "x", Cost: -1, Actions: []string{"a"}},
	}}).Validate(); err == nil {
		t.Fatal("expected error for negative cost")
	}
}

// TestRandomizedEnumerationAgreement cross-checks the branch-and-bound solver
// against the independent full-subset enumeration on random instances.
func TestRandomizedEnumerationAgreement(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	actions := []string{"a", "b", "c", "d"}
	for trial := 0; trial < 300; trial++ {
		n := 1 + rng.Intn(9)
		spec := &Spec{Demands: map[string]int{}}
		for i := 0; i < n; i++ {
			r := Rule{ID: string(rune('A' + i)), Cost: int64(rng.Intn(6))}
			for _, a := range actions {
				if rng.Intn(2) == 0 {
					r.Actions = append(r.Actions, a)
				}
			}
			if len(r.Actions) == 0 {
				r.Actions = []string{actions[rng.Intn(len(actions))]}
			}
			if rng.Intn(3) == 0 {
				r.Capacity = 1 + rng.Intn(3)
			}
			if i > 0 && rng.Intn(4) == 0 {
				r.Requires = []string{string(rune('A' + rng.Intn(i)))}
			}
			if i > 0 && rng.Intn(4) == 0 {
				r.Excludes = []string{string(rune('A' + rng.Intn(i)))}
			}
			spec.Rules = append(spec.Rules, r)
		}
		for _, a := range actions {
			if rng.Intn(2) == 0 {
				spec.Demands[a] = 1 + rng.Intn(3)
			}
		}
		if rng.Intn(4) == 0 {
			spec.Forbidden = []string{actions[rng.Intn(len(actions))]}
		}
		if rng.Intn(3) == 0 {
			spec.GlobalQuota = 1 + rng.Intn(6)
		}
		rep := planOrFail(t, spec)
		if !rep.Verification.Subsets.Completed {
			t.Fatalf("trial %d: enumeration incomplete", trial)
		}
		if !rep.Verification.Subsets.MatchesSolver {
			t.Fatalf("trial %d: solver/enumeration mismatch on %+v\nsolver: %v %v\nenum: %+v",
				trial, spec, rep.Status, rep.SelectedRules, rep.Verification.Subsets)
		}
		if !rep.Verification.Assignments.Consistent {
			t.Fatalf("trial %d: assignment check inconsistent", trial)
		}
		if rep.Bounds.Optimal != nil {
			if rep.Bounds.Lower > *rep.Bounds.Optimal {
				t.Fatalf("trial %d: lower bound violated", trial)
			}
			if rep.Bounds.Upper != nil && *rep.Bounds.Upper < *rep.Bounds.Optimal {
				t.Fatalf("trial %d: upper bound violated", trial)
			}
		}
	}
}

func TestEmptyDemands(t *testing.T) {
	rep := planOrFail(t, &Spec{
		Rules:   []Rule{{ID: "r1", Cost: 1, Actions: []string{"a"}}},
		Demands: map[string]int{},
	})
	mustOptimal(t, rep, 0)
	checkVerification(t, rep)
}

func TestMaxRulesAccepted(t *testing.T) {
	spec := &Spec{Demands: map[string]int{"a": 1}}
	for i := 0; i < MaxRules; i++ {
		spec.Rules = append(spec.Rules, Rule{ID: string(rune('a' + i)), Cost: int64(i + 1), Actions: []string{"a"}})
	}
	rep := planOrFail(t, spec)
	mustOptimal(t, rep, 1, "a")
	if !rep.Verification.Subsets.MatchesSolver {
		t.Fatal("enumeration mismatch at 22 rules")
	}
}
