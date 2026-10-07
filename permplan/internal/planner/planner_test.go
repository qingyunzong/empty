package planner

import (
	"math/rand"
	"testing"
)

// --- helpers ---------------------------------------------------------------

func rule(id string, cost, use int64, cap int, actions map[string]int) Rule {
	return Rule{ID: id, Cost: cost, UseCost: use, Capacity: cap, Actions: actions}
}

func mustSolve(t *testing.T, in *Input) *Solution {
	t.Helper()
	if err := in.Validate(); err != nil {
		t.Fatalf("invalid input: %v", err)
	}
	sol, _ := Solve(in)
	if sol == nil {
		t.Fatalf("expected feasible, got infeasible")
	}
	return sol
}

// --- targeted constraint tests --------------------------------------------

func TestForbiddenRuleExcluded(t *testing.T) {
	in := &Input{
		Rules: []Rule{
			rule("cheap-but-evil", 1, 0, 0, map[string]int{"read": 5, "delete": 1}),
			rule("clean", 10, 0, 0, map[string]int{"read": 5}),
		},
		Demands:   map[string]int{"read": 2},
		Forbidden: []string{"delete"},
	}
	sol := mustSolve(t, in)
	if len(sol.Rules) != 1 || sol.Rules[0] != "clean" {
		t.Fatalf("forbidden-covering rule selected: %v", sol.Rules)
	}
	if sol.Cost != 10 {
		t.Fatalf("cost = %d, want 10", sol.Cost)
	}
}

func TestForbiddenUnselectableViaPrereq(t *testing.T) {
	// "addon" requires a rule that covers a forbidden action, so it
	// must be excluded too; with no other provider the instance is
	// infeasible.
	in := &Input{
		Rules: []Rule{
			rule("evil-base", 1, 0, 0, map[string]int{"x": 1, "wipe": 1}),
			rule("addon", 1, 0, 0, map[string]int{"y": 1}),
		},
		Prereqs:   []Prereq{{Rule: "addon", Requires: "evil-base"}},
		Demands:   map[string]int{"y": 1},
		Forbidden: []string{"wipe"},
	}
	sol, inst := Solve(in)
	if sol != nil {
		t.Fatalf("expected infeasible, got %+v", sol)
	}
	if len(inst.excluded) != 2 {
		t.Fatalf("expected 2 exclusions, got %v", inst.excluded)
	}
}

func TestMutex(t *testing.T) {
	in := &Input{
		Rules: []Rule{
			rule("a", 1, 0, 0, map[string]int{"x": 1}),
			rule("b", 1, 0, 0, map[string]int{"y": 1}),
			rule("c", 5, 0, 0, map[string]int{"x": 1, "y": 1}),
		},
		Mutex:   [][2]string{{"a", "b"}},
		Demands: map[string]int{"x": 1, "y": 1},
	}
	sol := mustSolve(t, in)
	if len(sol.Rules) != 1 || sol.Rules[0] != "c" || sol.Cost != 5 {
		t.Fatalf("mutex not respected: %+v", sol)
	}
}

func TestPrereq(t *testing.T) {
	in := &Input{
		Rules: []Rule{
			rule("base", 3, 0, 0, map[string]int{"x": 1}),
			rule("addon", 1, 0, 0, map[string]int{"y": 1}),
		},
		Prereqs: []Prereq{{Rule: "addon", Requires: "base"}},
		Demands: map[string]int{"y": 1},
	}
	sol := mustSolve(t, in)
	if len(sol.Rules) != 2 || sol.Cost != 4 {
		t.Fatalf("prereq chain not pulled in: %+v", sol)
	}
}

func TestQuota(t *testing.T) {
	in := &Input{
		Rules:   []Rule{rule("a", 1, 0, 0, map[string]int{"x": 5})},
		Quota:   2,
		Demands: map[string]int{"x": 3},
	}
	if sol, _ := Solve(in); sol != nil {
		t.Fatalf("quota violated but solution returned: %+v", sol)
	}
}

func TestMultisetDemandNotSetCover(t *testing.T) {
	// "small" covers action x only twice: a pure set-cover solver would
	// wrongly accept it for a 3-unit demand.
	in := &Input{
		Rules: []Rule{
			rule("small", 1, 0, 0, map[string]int{"x": 2}),
			rule("big", 5, 0, 0, map[string]int{"x": 3}),
		},
		Demands: map[string]int{"x": 3},
	}
	sol := mustSolve(t, in)
	if len(sol.Rules) != 1 || sol.Rules[0] != "big" || sol.Cost != 5 {
		t.Fatalf("multiset demand mishandled: %+v", sol)
	}
}

func TestCapacityForcesTwoRules(t *testing.T) {
	in := &Input{
		Rules: []Rule{
			rule("a", 2, 0, 2, map[string]int{"x": 10}),
			rule("b", 2, 0, 2, map[string]int{"x": 10}),
			rule("huge", 100, 0, 0, map[string]int{"x": 10}),
		},
		Demands: map[string]int{"x": 4},
	}
	sol := mustSolve(t, in)
	if len(sol.Rules) != 2 || sol.Cost != 4 {
		t.Fatalf("capacity not enforced: %+v", sol)
	}
}

func TestUseCostDrivesAssignment(t *testing.T) {
	// Both rules must be selected (b is the only y provider); the x
	// unit must go to whichever rule is cheaper per use.
	in := &Input{
		Rules: []Rule{
			rule("a", 0, 5, 0, map[string]int{"x": 1}),
			rule("b", 0, 1, 0, map[string]int{"x": 1, "y": 1}),
		},
		Demands: map[string]int{"x": 1, "y": 1},
	}
	sol := mustSolve(t, in)
	if sol.UseCost != 2 { // both units served by b at 1 each
		t.Fatalf("use cost = %d, want 2: %+v", sol.UseCost, sol.Assignments)
	}
	for _, a := range sol.Assignments {
		if a.Rule != "b" {
			t.Fatalf("assignment not cost-minimal: %+v", sol.Assignments)
		}
	}
}

func TestTieBreakByIDOrder(t *testing.T) {
	in := &Input{
		Rules: []Rule{
			rule("r2", 5, 0, 0, map[string]int{"x": 1}),
			rule("r1", 5, 0, 0, map[string]int{"x": 1}),
		},
		Demands: map[string]int{"x": 1},
	}
	sol := mustSolve(t, in)
	if len(sol.Rules) != 1 || sol.Rules[0] != "r1" {
		t.Fatalf("tie not broken by ID order: %v", sol.Rules)
	}
}

func TestInfeasible(t *testing.T) {
	in := &Input{
		Rules:   []Rule{rule("a", 1, 0, 0, map[string]int{"x": 1})},
		Demands: map[string]int{"y": 1},
	}
	if sol, _ := Solve(in); sol != nil {
		t.Fatalf("expected infeasible, got %+v", sol)
	}
}

func TestBoundsBracketOptimum(t *testing.T) {
	in := &Input{
		Rules: []Rule{
			rule("a", 4, 1, 0, map[string]int{"x": 2, "y": 1}),
			rule("b", 3, 2, 0, map[string]int{"y": 2}),
			rule("c", 1, 9, 1, map[string]int{"x": 1, "y": 1}),
		},
		Demands: map[string]int{"x": 2, "y": 2},
	}
	sol := mustSolve(t, in)
	b := ComputeBounds(in)
	if b.Lower > sol.Cost {
		t.Fatalf("lower bound %d above optimum %d", b.Lower, sol.Cost)
	}
	if !b.UpperOK || b.Upper < sol.Cost {
		t.Fatalf("upper bound %+v below optimum %d", b, sol.Cost)
	}
}

// --- certificate tests -----------------------------------------------------

func TestCertificateRoundTrip(t *testing.T) {
	in := &Input{
		Rules: []Rule{
			rule("base", 3, 0, 0, map[string]int{"read": 2}),
			rule("writer", 4, 1, 3, map[string]int{"write": 2, "read": 1}),
			rule("evil", 1, 0, 0, map[string]int{"read": 9, "delete": 1}),
		},
		Prereqs:   []Prereq{{Rule: "writer", Requires: "base"}},
		Quota:     5,
		Demands:   map[string]int{"read": 2, "write": 2},
		Forbidden: []string{"delete"},
	}
	cert, err := BuildCertificate(in)
	if err != nil {
		t.Fatal(err)
	}
	if cert.Status != "optimal" {
		t.Fatalf("status = %s", cert.Status)
	}
	if !cert.Verify.Ran || !cert.Verify.SubsetEnumMatch || !cert.Verify.AssignmentEnumMatch {
		t.Fatalf("enumeration cross-check failed: %+v", cert.Verify)
	}
	for _, c := range cert.Coverage {
		if !c.OK {
			t.Fatalf("coverage entry not satisfied: %+v", c)
		}
	}
	if !cert.Deps.OK || !cert.Quota.OK {
		t.Fatalf("dependency/quota cert not OK: %+v %+v", cert.Deps, cert.Quota)
	}
	if len(cert.Forbidden) != 1 || cert.Forbidden[0].Rule != "evil" {
		t.Fatalf("forbidden cert wrong: %+v", cert.Forbidden)
	}
	// Per-rule usage must be consistent with assignments.
	usageTotal := 0
	for _, ru := range cert.RuleUsage {
		usageTotal += ru.Total
	}
	if usageTotal != 4 {
		t.Fatalf("rule usage totals %d, want 4", usageTotal)
	}
	if problems := CheckCertificate(in, cert); len(problems) > 0 {
		t.Fatalf("certificate rejected: %v", problems)
	}
}

func TestCertificateTamperingDetected(t *testing.T) {
	in := &Input{
		Rules: []Rule{
			rule("a", 2, 0, 0, map[string]int{"x": 1}),
			rule("b", 3, 0, 0, map[string]int{"x": 1}),
		},
		Demands: map[string]int{"x": 1},
	}
	cert, err := BuildCertificate(in)
	if err != nil {
		t.Fatal(err)
	}
	cert.Solution.Cost-- // tamper
	if problems := CheckCertificate(in, cert); len(problems) == 0 {
		t.Fatalf("tampered certificate accepted")
	}
}

// --- randomized cross-check against independent brute force ----------------

func randomInstance(r *rand.Rand) *Input {
	actions := []string{"a", "b", "c"}
	n := 1 + r.Intn(7) // 1..7 rules keeps brute force cheap
	in := &Input{Demands: map[string]int{}}
	for i := 0; i < n; i++ {
		ru := Rule{
			ID:      string(rune('A' + i)),
			Cost:    int64(r.Intn(6)),
			UseCost: int64(r.Intn(4)),
			Actions: map[string]int{},
		}
		if r.Intn(3) == 0 {
			ru.Capacity = 1 + r.Intn(4)
		}
		for _, a := range actions {
			if r.Intn(2) == 0 {
				ru.Actions[a] = 1 + r.Intn(3)
			}
		}
		if len(ru.Actions) == 0 {
			ru.Actions[actions[r.Intn(len(actions))]] = 1
		}
		in.Rules = append(in.Rules, ru)
	}
	for _, a := range actions {
		if r.Intn(2) == 0 {
			in.Demands[a] = 1 + r.Intn(3)
		}
	}
	if len(in.Demands) == 0 {
		in.Demands["a"] = 1
	}
	// Random mutex pairs.
	for i := 0; i < n; i++ {
		for j := i + 1; j < n; j++ {
			if r.Intn(8) == 0 {
				in.Mutex = append(in.Mutex, [2]string{in.Rules[i].ID, in.Rules[j].ID})
			}
		}
	}
	// Random acyclic prerequisites (i requires j only when j < i).
	for i := 1; i < n; i++ {
		if r.Intn(4) == 0 {
			in.Prereqs = append(in.Prereqs, Prereq{Rule: in.Rules[i].ID, Requires: in.Rules[r.Intn(i)].ID})
		}
	}
	if r.Intn(2) == 0 {
		in.Quota = 1 + r.Intn(8)
	}
	if r.Intn(3) == 0 {
		in.Forbidden = []string{actions[r.Intn(len(actions))]}
	}
	return in
}

func TestRandomizedAgainstBruteForce(t *testing.T) {
	r := rand.New(rand.NewSource(20261007))
	for trial := 0; trial < 300; trial++ {
		in := randomInstance(r)
		if err := in.Validate(); err != nil {
			t.Fatalf("trial %d: invalid generated input: %v", trial, err)
		}
		sol, _ := Solve(in)
		bruteCost, bruteSel := BruteForce(in)
		if sol == nil {
			if bruteCost != noSolution {
				t.Fatalf("trial %d: solver infeasible but brute force found %d (%v)", trial, bruteCost, bruteSel)
			}
			continue
		}
		if bruteCost == noSolution {
			t.Fatalf("trial %d: solver found %d but brute force infeasible", trial, sol.Cost)
		}
		if sol.Cost != bruteCost {
			t.Fatalf("trial %d: solver cost %d != brute force %d", trial, sol.Cost, bruteCost)
		}
		// Every certificate must validate.
		cert, err := BuildCertificate(in)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		if !cert.Verify.SubsetEnumMatch || !cert.Verify.AssignmentEnumMatch {
			t.Fatalf("trial %d: cross-check mismatch: %+v", trial, cert.Verify)
		}
		if problems := CheckCertificate(in, cert); len(problems) > 0 {
			t.Fatalf("trial %d: certificate invalid: %v", trial, problems)
		}
		// Bounds must bracket the optimum.
		if cert.Bounds.Lower > sol.Cost {
			t.Fatalf("trial %d: lower bound %d > optimum %d", trial, cert.Bounds.Lower, sol.Cost)
		}
		if cert.Bounds.UpperOK && cert.Bounds.Upper < sol.Cost {
			t.Fatalf("trial %d: upper bound %d < optimum %d", trial, cert.Bounds.Upper, sol.Cost)
		}
	}
}

func TestTwentyTwoRulesPerformance(t *testing.T) {
	// Worst-case size: 22 rules, no constraints, all feasible.
	in := &Input{Demands: map[string]int{"a": 3, "b": 2}}
	for i := 0; i < 22; i++ {
		in.Rules = append(in.Rules, rule(
			string(rune('a'+i)), int64(22-i), int64(i%3), 0,
			map[string]int{"a": 2, "b": 2},
		))
	}
	sol := mustSolve(t, in)
	// Cheapest plan: rules with use cost 0 and smallest fixed costs
	// covering 3 a-units and 2 b-units (each rule gives 2+2).
	b := ComputeBounds(in)
	if b.Lower > sol.Cost || (b.UpperOK && b.Upper < sol.Cost) {
		t.Fatalf("bounds %+v do not bracket optimum %d", b, sol.Cost)
	}
	t.Logf("22-rule optimum: cost=%d rules=%v", sol.Cost, sol.Rules)
}
