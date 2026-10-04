package checker

import (
	"slices"
	"testing"
)

func ptr(i int) *int { return &i }

func mustModel(t *testing.T, spec Spec) *Model {
	t.Helper()
	m, err := NewModel(spec)
	if err != nil {
		t.Fatalf("NewModel: %v", err)
	}
	return m
}

func TestShortestViolationLexTieBreak(t *testing.T) {
	// Two shortest violating traces of length 2: "a b" via s1 and "b a" via
	// s2. Event ID order a < b must select "a b".
	m := mustModel(t, Spec{
		States:  []string{"s0", "s1", "s2", "s3"},
		Initial: "s0",
		Events:  []string{"a", "b"},
		Transitions: []Transition{
			{From: "s0", Event: "a", To: "s1"},
			{From: "s0", Event: "b", To: "s2"},
			{From: "s1", Event: "b", To: "s3"},
			{From: "s2", Event: "a", To: "s3"},
		},
		Bad: []string{"s3"},
	})
	tr, ok := m.ShortestViolation(10)
	if !ok {
		t.Fatal("expected a violation")
	}
	if !slices.Equal(tr.Events, []string{"a", "b"}) {
		t.Fatalf("expected events [a b], got %v", tr.Events)
	}
	if !slices.Equal(tr.States, []string{"s0", "s1", "s3"}) {
		t.Fatalf("expected states [s0 s1 s3], got %v", tr.States)
	}
}

func TestBudgetBoundary(t *testing.T) {
	// Chain s0 -e-> s1 -e-> ... -e-> s5; bad = {s5}. The violation needs
	// exactly 5 steps.
	spec := Spec{
		States:  []string{"s0", "s1", "s2", "s3", "s4", "s5"},
		Initial: "s0",
		Events:  []string{"e"},
		Bad:     []string{"s5"},
	}
	for i := 0; i < 5; i++ {
		spec.Transitions = append(spec.Transitions,
			Transition{From: spec.States[i], Event: "e", To: spec.States[i+1]})
	}
	m := mustModel(t, spec)

	if _, ok := m.ShortestViolation(4); ok {
		t.Fatal("budget 4: expected no violation (needs 5 steps)")
	}
	tr, ok := m.ShortestViolation(5)
	if !ok {
		t.Fatal("budget 5: expected violation at exactly 5 steps")
	}
	if len(tr.Events) != 5 {
		t.Fatalf("expected 5 steps, got %d", len(tr.Events))
	}
	// Exact safety must see through any budget below 5.
	if _, ok := m.ExactSafety(); !ok {
		t.Fatal("exact safety: expected violation")
	}
}

func TestInitialStateBad(t *testing.T) {
	m := mustModel(t, Spec{
		States:  []string{"s0"},
		Initial: "s0",
		Events:  []string{"a"},
		Bad:     []string{"s0"},
	})
	tr, ok := m.ShortestViolation(0)
	if !ok {
		t.Fatal("expected violation at depth 0")
	}
	if len(tr.Events) != 0 || len(tr.States) != 1 {
		t.Fatalf("expected empty trace, got %+v", tr)
	}
}

func TestNoViolationAnywhere(t *testing.T) {
	m := mustModel(t, Spec{
		States:  []string{"s0", "s1"},
		Initial: "s0",
		Events:  []string{"a"},
		Transitions: []Transition{
			{From: "s0", Event: "a", To: "s1"},
			{From: "s1", Event: "a", To: "s0"},
		},
	})
	if _, ok := m.ShortestViolation(10); ok {
		t.Fatal("unexpected bounded violation")
	}
	if _, ok := m.ExactSafety(); ok {
		t.Fatal("unexpected exact violation")
	}
}

func TestNondeterministicTargets(t *testing.T) {
	// s0 -a-> {s1, s2}; only s2 reaches the bad state.
	m := mustModel(t, Spec{
		States:  []string{"s0", "s1", "s2", "s3"},
		Initial: "s0",
		Events:  []string{"a", "b"},
		Transitions: []Transition{
			{From: "s0", Event: "a", To: "s1"},
			{From: "s0", Event: "a", To: "s2"},
			{From: "s2", Event: "b", To: "s3"},
		},
		Bad: []string{"s3"},
	})
	tr, ok := m.ShortestViolation(10)
	if !ok {
		t.Fatal("expected violation")
	}
	if !slices.Equal(tr.Events, []string{"a", "b"}) {
		t.Fatalf("expected [a b], got %v", tr.Events)
	}
}
