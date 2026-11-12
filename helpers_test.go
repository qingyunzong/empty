package dataeng_test

import (
	"fmt"
	"testing"

	dq "example.org/dataeng/q0294"
)

func mustCheck(t *testing.T, problem dq.Problem, budget int) dq.Result {
	t.Helper()
	result, err := dq.Check(problem, budget)
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	return result
}

func mustResume(t *testing.T, problem dq.Problem, cursor *dq.Cursor, budget int) dq.Result {
	t.Helper()
	result, err := dq.Resume(problem, cursor, budget)
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	return result
}

func requireContained(t *testing.T, result dq.Result, wantSteps int) {
	t.Helper()
	if result.Status != dq.Contained {
		t.Fatalf("status = %v, want contained (counterexample=%v)", result.Status, result.Counterexample)
	}
	if result.Counterexample != nil {
		t.Fatalf("contained result unexpectedly has a counterexample")
	}
	if result.Cursor != nil {
		t.Fatalf("contained result unexpectedly has a cursor")
	}
	if wantSteps >= 0 && result.Steps != wantSteps {
		t.Fatalf("Steps = %d, want %d", result.Steps, wantSteps)
	}
}

func requireNotContained(t *testing.T, result dq.Result, wantSteps int) {
	t.Helper()
	if result.Status != dq.NotContained {
		t.Fatalf("status = %v, want not-contained", result.Status)
	}
	if result.Counterexample == nil {
		t.Fatalf("not-contained result has no counterexample")
	}
	if result.Mapping != nil {
		t.Fatalf("not-contained result unexpectedly has a mapping")
	}
	if result.Cursor != nil {
		t.Fatalf("not-contained result unexpectedly has a cursor")
	}
	if wantSteps >= 0 && result.Steps != wantSteps {
		t.Fatalf("Steps = %d, want %d", result.Steps, wantSteps)
	}
}

func requireUndecided(t *testing.T, result dq.Result, wantSteps int) {
	t.Helper()
	if result.Status != dq.Undecided {
		t.Fatalf("status = %v, want undecided", result.Status)
	}
	if result.Cursor == nil {
		t.Fatalf("undecided result has no cursor")
	}
	if result.Mapping != nil || result.Counterexample != nil {
		t.Fatalf("undecided result must not claim a decision")
	}
	if wantSteps >= 0 && result.Steps != wantSteps {
		t.Fatalf("Steps = %d, want %d", result.Steps, wantSteps)
	}
}

func mappingTarget(t *testing.T, mapping dq.Mapping, variable string) dq.Term {
	t.Helper()
	term, ok := mapping.Lookup(variable)
	if !ok {
		t.Fatalf("mapping has no binding for %q; mapping=%v", variable, mapping)
	}
	return term
}

func verifyCounterexample(t *testing.T, subquery, superquery dq.Query, counterexample *dq.Counterexample) {
	t.Helper()
	if counterexample == nil {
		t.Fatalf("counterexample is nil")
	}

	subResult, err := dq.Evaluate(subquery, counterexample.Database)
	if err != nil {
		t.Fatalf("Evaluate(subquery, counterexample.DB): %v", err)
	}
	if !subResult.Contains(counterexample.Head) {
		t.Fatalf("subquery does not produce counterexample head %v; answers=%v", counterexample.Head, subResult)
	}

	superResult, err := dq.Evaluate(superquery, counterexample.Database)
	if err != nil {
		t.Fatalf("Evaluate(superquery, counterexample.DB): %v", err)
	}
	if superResult.Contains(counterexample.Head) {
		t.Fatalf("superquery also produces counterexample head %v; answers=%v", counterexample.Head, superResult)
	}

	inSub, err := dq.ContainsTuple(subquery, counterexample.Database, counterexample.Head)
	if err != nil {
		t.Fatalf("ContainsTuple(subquery): %v", err)
	}
	if !inSub {
		t.Fatalf("targeted interpreter says subquery does not contain the head")
	}
	inSuper, err := dq.ContainsTuple(superquery, counterexample.Database, counterexample.Head)
	if err != nil {
		t.Fatalf("ContainsTuple(superquery): %v", err)
	}
	if inSuper {
		t.Fatalf("targeted interpreter says superquery contains the head")
	}
}

func relationRows(db dq.Database, relation string) []dq.Tuple {
	return db.Relations[relation]
}

func databaseSignature(db dq.Database) string {
	relations := make([]string, 0, len(db.Relations))
	for relation := range db.Relations {
		relations = append(relations, relation)
	}
	sortStrings(relations)
	var out string
	for _, relation := range relations {
		out += fmt.Sprintf("%s=[", relation)
		for _, tuple := range db.Relations[relation] {
			out += fmt.Sprintf("%v", tuple)
		}
		out += "]"
	}
	return out
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
