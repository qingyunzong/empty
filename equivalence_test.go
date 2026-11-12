package dataeng_test

import (
	"testing"

	dq "example.org/dataeng/q0294"
)

func TestCheckEquivalenceBothDirections(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1, "S": 1})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
		dq.NewAtom("S", dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("S", dq.Var("x")),
		dq.NewAtom("R", dq.Var("x")),
	)
	result, err := dq.CheckEquivalence(dq.Problem{Schema: schema, A: a, B: b}, dq.Unlimited)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Decided || !result.Equal {
		t.Fatalf("equivalence = (decided=%v, equal=%v), want true/true", result.Decided, result.Equal)
	}
	if result.AB.Status != dq.Contained || result.BA.Status != dq.Contained {
		t.Fatalf("directions = (%v, %v), want contained/contained", result.AB.Status, result.BA.Status)
	}
}

func TestCheckEquivalenceDetectsProjectionDifference(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1, "S": 1})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
		dq.NewAtom("S", dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
	)
	result, err := dq.CheckEquivalence(dq.Problem{Schema: schema, A: a, B: b}, dq.Unlimited)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Decided || result.Equal {
		t.Fatalf("equivalence = (decided=%v, equal=%v), want true/false", result.Decided, result.Equal)
	}
	if result.AB.Status != dq.Contained {
		t.Fatalf("A contained in B = %v, want contained", result.AB.Status)
	}
	if result.BA.Status != dq.NotContained {
		t.Fatalf("B contained in A = %v, want not-contained", result.BA.Status)
	}
	verifyCounterexample(t, b, a, result.BA.Counterexample)
}

func TestCheckEquivalenceCanBeUndecided(t *testing.T) {
	schema := dq.NewSchema(map[string]int{"R": 1})
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
	)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("y")},
		dq.NewAtom("R", dq.Var("y")),
	)
	result, err := dq.CheckEquivalence(dq.Problem{Schema: schema, A: a, B: b}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if result.Decided {
		t.Fatalf("zero budget with a variable should be undecided")
	}
	if result.Equal {
		t.Fatalf("undecided equivalence must not claim equality")
	}
	if result.AB.Status != dq.Undecided || result.BA.Status != dq.Undecided {
		t.Fatalf("directions = (%v, %v), want undecided/undecided", result.AB.Status, result.BA.Status)
	}
	if result.AB.Cursor == nil || result.BA.Cursor == nil {
		t.Fatalf("undecided equivalence directions must expose cursors")
	}

	problem := dq.Problem{Schema: schema, A: a, B: b}
	if _, err := dq.Resume(problem, result.AB.Cursor, dq.Unlimited); err != nil {
		t.Fatal(err)
	}
	if _, err := dq.Resume(problem.Reverse(), result.BA.Cursor, dq.Unlimited); err != nil {
		t.Fatal(err)
	}
}
