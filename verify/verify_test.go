package verify

import (
	"slices"
	"strings"
	"testing"

	"faircheck/checker"
)

// allTables enumerates every deterministic 3-state, 2-event state table:
// each (state, event) pair either has no transition or goes to one of the
// 3 states (4^6 = 4096 tables).
func allTables(f func(spec checker.Spec)) {
	states := []string{"s0", "s1", "s2"}
	events := []string{"a", "b"}
	for code := 0; code < 1<<12; code++ {
		x := code
		var trans []checker.Transition
		for i := 0; i < 6; i++ {
			v := x & 3
			x >>= 2
			if v == 3 {
				continue
			}
			trans = append(trans, checker.Transition{
				From:  states[i/2],
				Event: events[i%2],
				To:    states[v],
			})
		}
		f(checker.Spec{States: states, Initial: "s0", Events: events, Transitions: trans})
	}
}

func subsets(names []string, f func(sub []string)) {
	for mask := 0; mask < 1<<len(names); mask++ {
		var sub []string
		for i, n := range names {
			if mask&(1<<i) != 0 {
				sub = append(sub, n)
			}
		}
		f(sub)
	}
}

// TestExhaustiveBoundedCrossCheck compares checker's BFS against the
// independent layered enumeration on every small table, every bad-state
// set, and budgets around the violation length (budget boundary).
func TestExhaustiveBoundedCrossCheck(t *testing.T) {
	allTables(func(base checker.Spec) {
		subsets(base.States, func(bad []string) {
			spec := base
			spec.Bad = bad
			m, err := checker.NewModel(spec)
			if err != nil {
				t.Fatalf("NewModel: %v", err)
			}
			for budget := 0; budget <= 4; budget++ {
				tr, hit := m.ShortestViolation(budget)
				seq, enumHit := LayeredMinViolation(spec, budget)
				if hit != enumHit {
					t.Fatalf("budget %d spec %+v: checker hit=%v, enumeration hit=%v",
						budget, spec, hit, enumHit)
				}
				if hit && !slices.Equal(tr.Events, seq) {
					t.Fatalf("budget %d spec %+v: checker=%v enumeration=%v",
						budget, spec, tr.Events, seq)
				}
			}
			// Exact safety must agree with enumeration at depth NumStates.
			_, exactHit := m.ExactSafety()
			_, enumExact := LayeredMinViolation(spec, m.NumStates())
			if exactHit != enumExact {
				t.Fatalf("exact safety mismatch on %+v", spec)
			}
		})
	})
}

// TestExhaustiveFairCrossCheck compares checker's fair-cycle search against
// the independent subset enumeration, and validates every lasso by
// unrolling and every SCC evidence by mutual reachability.
func TestExhaustiveFairCrossCheck(t *testing.T) {
	allTables(func(base checker.Spec) {
		subsets(base.States, func(goal []string) {
			spec := base
			spec.Goal = goal
			m, err := checker.NewModel(spec)
			if err != nil {
				t.Fatalf("NewModel: %v", err)
			}
			lasso, evidence, hit := m.FairViolation()
			witness, found := CheckNoFairCycle(spec)
			if hit != found {
				t.Fatalf("spec %+v: checker hit=%v but independent search found fair cycle on %v",
					spec, hit, witness)
			}
			if hit {
				if err := CheckLasso(spec, lasso, 3); err != nil {
					t.Fatalf("spec %+v: lasso failed unrolling check: %v", spec, err)
				}
			} else {
				if err := CheckSCCEvidence(spec, evidence); err != nil {
					t.Fatalf("spec %+v: SCC evidence invalid: %v", spec, err)
				}
			}
		})
	})
}

func tamperSpec() checker.Spec {
	return checker.Spec{
		States:  []string{"s0", "s1", "g"},
		Initial: "s0",
		Events:  []string{"a", "b"},
		Transitions: []checker.Transition{
			{From: "s0", Event: "a", To: "s1"},
			{From: "s1", Event: "a", To: "s1"},
			{From: "s1", Event: "b", To: "s1"},
			{From: "s1", Event: "b", To: "g"},
			{From: "g", Event: "b", To: "s1"},
		},
		Goal: []string{"g"},
	}
}

func TestCheckLassoUnrolling(t *testing.T) {
	spec := tamperSpec()
	m, err := checker.NewModel(spec)
	if err != nil {
		t.Fatal(err)
	}
	lasso, _, hit := m.FairViolation()
	if !hit {
		t.Fatal("expected a lasso")
	}
	if err := CheckLasso(spec, lasso, 3); err != nil {
		t.Fatalf("valid lasso rejected: %v", err)
	}

	// Dropping the continuously enabled event b breaks fairness.
	unfair := lasso
	unfair.Cycle = checker.Trace{States: []string{"s1", "s1"}, Events: []string{"a"}}
	if err := CheckLasso(spec, unfair, 3); err == nil ||
		!strings.Contains(err.Error(), "continuously enabled") {
		t.Fatalf("expected fairness error, got %v", err)
	}

	// Routing the cycle through the goal state is caught by unrolling.
	throughGoal := lasso
	throughGoal.Cycle = checker.Trace{
		States: []string{"s1", "g", "s1"},
		Events: []string{"b", "b"},
	}
	if err := CheckLasso(spec, throughGoal, 3); err == nil ||
		!strings.Contains(err.Error(), "goal state") {
		t.Fatalf("expected goal-state error, got %v", err)
	}

	// A nonexistent transition is caught.
	broken := lasso
	broken.Cycle = checker.Trace{States: []string{"s1", "s0", "s1"}, Events: []string{"a", "a"}}
	if err := CheckLasso(spec, broken, 3); err == nil ||
		!strings.Contains(err.Error(), "no transition") {
		t.Fatalf("expected transition error, got %v", err)
	}

	// Prefix not ending at the cycle start is caught.
	detached := lasso
	detached.Cycle = checker.Trace{States: []string{"g", "s1", "g"}, Events: []string{"b", "b"}}
	if err := CheckLasso(spec, detached, 3); err == nil {
		t.Fatal("expected prefix/cycle mismatch error")
	}
}
