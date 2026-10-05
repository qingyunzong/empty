package mbt

import (
	"reflect"
	"testing"
)

func testModel(t *testing.T) *Model {
	t.Helper()
	return &Model{
		Initial: "A",
		States: map[string]State{
			"A": {},
			"B": {},
			"C": {},
		},
		Transitions: []Transition{
			{From: "A", Action: "ab", To: "B"},
			{From: "B", Action: "bc", To: "C"},
			{From: "C", Action: "ca", To: "A"},
			{From: "C", Action: "cc", To: "C"},
		},
	}
}

func TestShortestHistories(t *testing.T) {
	hist := NewExplorer(testModel(t)).ShortestHistories()
	want := map[string][]string{
		"A": {},
		"B": {"ab"},
		"C": {"ab", "bc"},
	}
	if !reflect.DeepEqual(hist, want) {
		t.Fatalf("histories = %v, want %v", hist, want)
	}
}

func TestGenerateCoversAllTransitionsWithinBudget(t *testing.T) {
	plan := NewExplorer(testModel(t)).Generate(3)
	if !plan.Closed {
		t.Fatalf("plan not closed: uncovered=%v unreachable=%v", plan.Uncovered, plan.Unreachable)
	}
	// 4 transitions -> 4 covering sequences, each <= 3 steps.
	if len(plan.Sequences) != 4 {
		t.Fatalf("got %d sequences, want 4", len(plan.Sequences))
	}
	for _, s := range plan.Sequences {
		if len(s.Actions) > 3 {
			t.Fatalf("sequence %v exceeds budget", s.Actions)
		}
	}
	// The cc self-loop is covered by the shortest history to C plus "cc".
	found := false
	for _, s := range plan.Sequences {
		if reflect.DeepEqual(s.Actions, []string{"ab", "bc", "cc"}) && s.Target == "C" {
			found = true
		}
	}
	if !found {
		t.Fatalf("self-loop transition not covered: %v", plan.Sequences)
	}
}

func TestGenerateBudgetTooSmall(t *testing.T) {
	plan := NewExplorer(testModel(t)).Generate(2)
	if plan.Closed {
		t.Fatal("plan closed with budget 2, want not closed")
	}
	if len(plan.Uncovered) != 2 { // ca and cc need 3 steps
		t.Fatalf("uncovered = %v, want 2 transitions", plan.Uncovered)
	}
}

func TestGenerateUnreachableState(t *testing.T) {
	m := testModel(t)
	m.States["Z"] = State{}
	plan := NewExplorer(m).Generate(5)
	if plan.Closed {
		t.Fatal("plan closed with unreachable state, want not closed")
	}
	if !reflect.DeepEqual(plan.Unreachable, []string{"Z"}) {
		t.Fatalf("unreachable = %v", plan.Unreachable)
	}
}

func TestIllegalFrom(t *testing.T) {
	m := testModel(t)
	if got := m.IllegalFrom("A"); !reflect.DeepEqual(got, []string{"bc", "ca", "cc"}) {
		t.Fatalf("illegal@A = %v", got)
	}
	if got := m.IllegalFrom("B"); !reflect.DeepEqual(got, []string{"ab", "ca", "cc"}) {
		t.Fatalf("illegal@B = %v", got)
	}
}
