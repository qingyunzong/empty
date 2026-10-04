package checker

import (
	"slices"
	"testing"
)

// lassoSpec: s0 -a-> s1; at s1 both a and b self-loop, and b may also reach
// the goal g. The fair cycle on {s1} must fire both a and b.
func lassoSpec() Spec {
	return Spec{
		States:  []string{"s0", "s1", "g"},
		Initial: "s0",
		Events:  []string{"a", "b"},
		Transitions: []Transition{
			{From: "s0", Event: "a", To: "s1"},
			{From: "s1", Event: "a", To: "s1"},
			{From: "s1", Event: "b", To: "s1"},
			{From: "s1", Event: "b", To: "g"},
		},
		Goal: []string{"g"},
	}
}

func TestFairViolationLasso(t *testing.T) {
	m := mustModel(t, lassoSpec())
	lasso, evidence, ok := m.FairViolation()
	if !ok {
		t.Fatalf("expected a fair violation, got evidence %+v", evidence)
	}
	if !slices.Equal(lasso.Prefix.Events, []string{"a"}) {
		t.Fatalf("expected prefix [a], got %v", lasso.Prefix.Events)
	}
	if !slices.Equal(lasso.Cycle.Events, []string{"a", "b"}) {
		t.Fatalf("expected cycle [a b], got %v", lasso.Cycle.Events)
	}
	if lasso.Cycle.States[0] != "s1" || lasso.Cycle.States[len(lasso.Cycle.States)-1] != "s1" {
		t.Fatalf("cycle must start and end at s1: %+v", lasso.Cycle)
	}
	if lasso.Prefix.States[len(lasso.Prefix.States)-1] != lasso.Cycle.States[0] {
		t.Fatal("prefix must end at the cycle start")
	}
}

func TestUnfairCycleOnlyYieldsSCCEvidence(t *testing.T) {
	// Like lassoSpec but b leaves {s1} for the goal: the only cycle is the
	// a-self-loop, which is unfair because b is continuously enabled.
	spec := lassoSpec()
	// Drop s1 -b-> s1, keep s1 -b-> g.
	spec.Transitions = append(spec.Transitions[:2], spec.Transitions[3])
	m := mustModel(t, spec)
	lasso, evidence, ok := m.FairViolation()
	if ok {
		t.Fatalf("expected no fair violation, got lasso %+v", lasso)
	}
	if len(evidence) != 2 {
		t.Fatalf("expected 2 SCC evidence entries, got %+v", evidence)
	}
	if evidence[0].Kind != "trivial" || !slices.Equal(evidence[0].States, []string{"s0"}) {
		t.Fatalf("expected trivial SCC {s0}, got %+v", evidence[0])
	}
	ev := evidence[1]
	if ev.Kind != "unfair" || ev.WitnessEvent != "b" {
		t.Fatalf("expected unfair SCC with witness b, got %+v", ev)
	}
	if !slices.Equal(ev.States, []string{"s1"}) {
		t.Fatalf("expected SCC {s1}, got %v", ev.States)
	}
}

func TestFairCycleMustFireContinuouslyEnabledEvent(t *testing.T) {
	// Two-state cycle p <-> q via a; b is enabled at both states (self-loops)
	// and must appear in the fair cycle.
	m := mustModel(t, Spec{
		States:  []string{"s0", "p", "q", "g"},
		Initial: "s0",
		Events:  []string{"a", "b"},
		Transitions: []Transition{
			{From: "s0", Event: "a", To: "p"},
			{From: "p", Event: "a", To: "q"},
			{From: "q", Event: "a", To: "p"},
			{From: "p", Event: "b", To: "p"},
			{From: "q", Event: "b", To: "q"},
			{From: "p", Event: "b", To: "g"},
		},
		Goal: []string{"g"},
	})
	lasso, _, ok := m.FairViolation()
	if !ok {
		t.Fatal("expected a fair violation")
	}
	if !slices.Contains(lasso.Cycle.Events, "b") {
		t.Fatalf("cycle %v must fire continuously enabled event b", lasso.Cycle.Events)
	}
	for _, s := range lasso.Cycle.States {
		if s == "g" {
			t.Fatalf("cycle must avoid goal states: %v", lasso.Cycle.States)
		}
	}
}

func TestUnreachableFairCycleIsNoViolation(t *testing.T) {
	// A fair cycle exists on {s1} but s1 is unreachable; s0 is a goal state.
	m := mustModel(t, Spec{
		States:  []string{"s0", "s1"},
		Initial: "s0",
		Events:  []string{"a"},
		Transitions: []Transition{
			{From: "s0", Event: "a", To: "s0"},
			{From: "s1", Event: "a", To: "s1"},
		},
		Goal: []string{"s0"},
	})
	if lasso, _, ok := m.FairViolation(); ok {
		t.Fatalf("unreachable fair cycle reported as violation: %+v", lasso)
	}
}

func TestNoGoalMeansAnyFairCycleViolates(t *testing.T) {
	m := mustModel(t, Spec{
		States:  []string{"s0"},
		Initial: "s0",
		Events:  []string{"a"},
		Transitions: []Transition{
			{From: "s0", Event: "a", To: "s0"},
		},
	})
	lasso, _, ok := m.FairViolation()
	if !ok {
		t.Fatal("expected a fair violation with empty goal")
	}
	if len(lasso.Prefix.Events) != 0 {
		t.Fatalf("expected empty prefix, got %v", lasso.Prefix.Events)
	}
	if !slices.Equal(lasso.Cycle.Events, []string{"a"}) {
		t.Fatalf("expected cycle [a], got %v", lasso.Cycle.Events)
	}
}

func TestTrivialSCCEvidence(t *testing.T) {
	// s1 has no enabled events: a trivial SCC, no infinite execution.
	m := mustModel(t, Spec{
		States:  []string{"s0", "s1"},
		Initial: "s0",
		Events:  []string{"a"},
		Transitions: []Transition{
			{From: "s0", Event: "a", To: "s1"},
		},
		Goal: []string{"s0"},
	})
	_, evidence, ok := m.FairViolation()
	if ok {
		t.Fatal("expected no fair violation")
	}
	if len(evidence) != 1 || evidence[0].Kind != "trivial" {
		t.Fatalf("expected trivial SCC evidence, got %+v", evidence)
	}
}
