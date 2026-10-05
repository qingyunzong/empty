package planner

import (
	"strings"
	"testing"
)

// spec builds a spec from costs and per-model flip lists, with the normal
// model reporting false for every assertion.
func spec(t *testing.T, assertions []Assertion, flips map[string][]string) Spec {
	t.Helper()
	models := []Model{{ID: "NORM", Outcomes: map[string]bool{}}}
	for _, a := range assertions {
		models[0].Outcomes[a.ID] = false
	}
	for id, fs := range flips {
		out := map[string]bool{}
		for _, a := range assertions {
			out[a.ID] = false
		}
		for _, f := range fs {
			out[f] = true
		}
		models = append(models, Model{ID: id, Outcomes: out})
	}
	return Spec{NormalID: "NORM", Assertions: assertions, Models: models}
}

func solve(t *testing.T, s Spec) *Certificate {
	t.Helper()
	p, err := Compile(s)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	cert, err := p.Solve()
	if err != nil {
		t.Fatalf("Solve: %v", err)
	}
	if !cert.Optimal {
		t.Fatalf("certificate not verified optimal:\n%s", cert.Format())
	}
	return cert
}

func TestSolveBasic(t *testing.T) {
	cert := solve(t, spec(t,
		[]Assertion{{ID: "A1", Cost: 5}, {ID: "A2", Cost: 2}, {ID: "A3", Cost: 2}},
		map[string][]string{"F1": {"A1", "A2"}, "F2": {"A2", "A3"}},
	))
	if cert.TotalCost != 2 || len(cert.Selected) != 1 || cert.Selected[0] != "A2" {
		t.Fatalf("want {A2} cost 2, got %v cost %d", cert.Selected, cert.TotalCost)
	}
	if len(cert.Witnesses) != 2 {
		t.Fatalf("want 2 witnesses, got %v", cert.Witnesses)
	}
}

func TestMutexExcludesCheaperCombination(t *testing.T) {
	// A1+A2 (cost 2) would cover both models but their side effects
	// conflict, so the optimum is A3 alone at cost 5.
	cert := solve(t, spec(t,
		[]Assertion{
			{ID: "A1", Cost: 1, Mutex: []string{"A2"}},
			{ID: "A2", Cost: 1},
			{ID: "A3", Cost: 5},
		},
		map[string][]string{"F1": {"A1", "A3"}, "F2": {"A2", "A3"}},
	))
	if cert.TotalCost != 5 || len(cert.Selected) != 1 || cert.Selected[0] != "A3" {
		t.Fatalf("want {A3} cost 5, got %v cost %d", cert.Selected, cert.TotalCost)
	}
}

func TestRequiresDragsPrerequisite(t *testing.T) {
	// A1 covers F1 cheaply but requires A2; the bundle (cost 5) still
	// beats A3 alone (cost 6).
	cert := solve(t, spec(t,
		[]Assertion{
			{ID: "A1", Cost: 1, Requires: []string{"A2"}},
			{ID: "A2", Cost: 4},
			{ID: "A3", Cost: 6},
		},
		map[string][]string{"F1": {"A1", "A3"}},
	))
	want := []string{"A1", "A2"}
	if cert.TotalCost != 5 || strings.Join(cert.Selected, ",") != strings.Join(want, ",") {
		t.Fatalf("want %v cost 5, got %v cost %d", want, cert.Selected, cert.TotalCost)
	}
}

func TestRequiresChainAndCycle(t *testing.T) {
	// Transitive chain: A1 -> A2 -> A3.
	cert := solve(t, spec(t,
		[]Assertion{
			{ID: "A1", Cost: 1, Requires: []string{"A2"}},
			{ID: "A2", Cost: 1, Requires: []string{"A3"}},
			{ID: "A3", Cost: 1},
		},
		map[string][]string{"F1": {"A1"}},
	))
	if cert.TotalCost != 3 || len(cert.Selected) != 3 {
		t.Fatalf("want full chain cost 3, got %v cost %d", cert.Selected, cert.TotalCost)
	}
	// Cycle A1 -> A2 -> A1 must be rejected.
	_, err := Compile(spec(t,
		[]Assertion{
			{ID: "A1", Cost: 1, Requires: []string{"A2"}},
			{ID: "A2", Cost: 1, Requires: []string{"A1"}},
		},
		map[string][]string{"F1": {"A1"}},
	))
	if err == nil || !strings.Contains(err.Error(), "cyclic") {
		t.Fatalf("want cyclic prerequisite error, got %v", err)
	}
}

func TestIndistinguishableListedSeparately(t *testing.T) {
	cert := solve(t, spec(t,
		[]Assertion{{ID: "A1", Cost: 1}},
		map[string][]string{"F1": {"A1"}, "F2": {}},
	))
	if len(cert.Indistinguishable) != 1 || cert.Indistinguishable[0] != "F2" {
		t.Fatalf("want F2 indistinguishable, got %v", cert.Indistinguishable)
	}
	if len(cert.Witnesses) != 1 || cert.Witnesses[0].Model != "F1" {
		t.Fatalf("want only F1 covered, got %v", cert.Witnesses)
	}
	if !strings.Contains(cert.Format(), "indistinguishable models (listed separately): F2") {
		t.Fatalf("certificate missing indistinguishable section:\n%s", cert.Format())
	}
}

func TestVerifyDetectsSuboptimalBound(t *testing.T) {
	p, err := Compile(spec(t,
		[]Assertion{{ID: "A1", Cost: 5}, {ID: "A2", Cost: 2}, {ID: "A3", Cost: 2}},
		map[string][]string{"F1": {"A1", "A2"}, "F2": {"A2", "A3"}},
	))
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	if ok, _ := p.Verify(2); !ok {
		t.Fatal("bound 2 is optimal, Verify must confirm")
	}
	if ok, checked := p.Verify(3); ok {
		t.Fatal("bound 3 is not optimal, Verify must reject")
	} else if checked == 0 {
		t.Fatal("Verify examined no subsets")
	}
}

func TestValidationLimits(t *testing.T) {
	many := make([]Assertion, MaxAssertions+1)
	for i := range many {
		many[i] = Assertion{ID: strings.Repeat("A", i+1), Cost: 1}
	}
	if _, err := Compile(spec(t, many, map[string][]string{"F1": {"A"}})); err == nil {
		t.Fatal("want error for too many assertions")
	}

	flips := map[string][]string{}
	for i := 0; i < MaxFaultModels+1; i++ {
		flips[strings.Repeat("F", i+1)] = []string{"A1"}
	}
	if _, err := Compile(spec(t, []Assertion{{ID: "A1", Cost: 1}}, flips)); err == nil {
		t.Fatal("want error for too many fault models")
	}

	bad := []Assertion{{ID: "A1", Cost: 1, Requires: []string{"NOPE"}}}
	if _, err := Compile(spec(t, bad, map[string][]string{"F1": {"A1"}})); err == nil {
		t.Fatal("want error for unknown prerequisite")
	}

	dup := []Assertion{{ID: "A1", Cost: 1}, {ID: "A1", Cost: 2}}
	if _, err := Compile(spec(t, dup, map[string][]string{"F1": {"A1"}})); err == nil {
		t.Fatal("want error for duplicate assertion id")
	}

	s := spec(t, []Assertion{{ID: "A1", Cost: 1}}, map[string][]string{"F1": {"A1"}})
	delete(s.Models[1].Outcomes, "A1")
	if _, err := Compile(s); err == nil {
		t.Fatal("want error for missing outcome")
	}
}

func TestInfeasible(t *testing.T) {
	// The only assertion distinguishing F1 can never be selected: its
	// prerequisites A2 and A3 are mutually exclusive.
	p, err := Compile(spec(t,
		[]Assertion{
			{ID: "A1", Cost: 1, Requires: []string{"A2", "A3"}},
			{ID: "A2", Cost: 1, Mutex: []string{"A3"}},
			{ID: "A3", Cost: 1},
		},
		map[string][]string{"F1": {"A1"}},
	))
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	if _, err := p.Solve(); err == nil {
		t.Fatal("want infeasible error")
	}
}

func TestDemoSpec(t *testing.T) {
	s := DemoSpec()
	if len(s.Assertions) != MaxAssertions {
		t.Fatalf("demo has %d assertions, want %d", len(s.Assertions), MaxAssertions)
	}
	if len(s.Models) != MaxFaultModels+1 {
		t.Fatalf("demo has %d models, want %d", len(s.Models), MaxFaultModels+1)
	}
	cert := solve(t, s)
	if len(cert.Indistinguishable) != 2 {
		t.Fatalf("want 2 indistinguishable demo models, got %v", cert.Indistinguishable)
	}
	if len(cert.Witnesses) != MaxFaultModels-2 {
		t.Fatalf("want %d witnesses, got %d", MaxFaultModels-2, len(cert.Witnesses))
	}
	// Every witness assertion must be selected and must actually
	// distinguish its model.
	selected := map[string]bool{}
	for _, id := range cert.Selected {
		selected[id] = true
	}
	normal := s.Models[0]
	flipped := map[string]map[string]bool{}
	for _, m := range s.Models[1:] {
		flipped[m.ID] = map[string]bool{}
		for _, a := range s.Assertions {
			if m.Outcomes[a.ID] != normal.Outcomes[a.ID] {
				flipped[m.ID][a.ID] = true
			}
		}
	}
	for _, w := range cert.Witnesses {
		if !selected[w.Assertion] {
			t.Errorf("witness %s for %s not selected", w.Assertion, w.Model)
		}
		if !flipped[w.Model][w.Assertion] {
			t.Errorf("witness %s does not distinguish %s", w.Assertion, w.Model)
		}
	}
	t.Logf("demo certificate:\n%s", cert.Format())
}
