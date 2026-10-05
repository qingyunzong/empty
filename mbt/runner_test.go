package mbt

import (
	"strings"
	"testing"
)

// fakeAdapter is an in-memory implementation under test. Its behavior
// is driven by a transition table plus fault flags, so tests can
// simulate correct and broken implementations.
type fakeAdapter struct {
	table        map[string]map[string]string // state -> action -> next
	state        string
	acceptBad    bool // accept illegal actions instead of rejecting
	corruptState bool // mutate state on illegal action
	wrongNext    bool // land in a wrong state on legal action
}

func newFakeAdapter() *fakeAdapter {
	return &fakeAdapter{
		table: map[string]map[string]string{
			"A": {"ab": "B"},
			"B": {"bc": "C"},
			"C": {"ca": "A", "cc": "C"},
		},
		state: "A",
	}
}

func (f *fakeAdapter) Reset() (Response, error) {
	f.state = "A"
	return Response{OK: true, State: f.state}, nil
}

func (f *fakeAdapter) Apply(action string) (Response, error) {
	next, ok := f.table[f.state][action]
	if !ok {
		if f.acceptBad {
			if f.corruptState {
				f.state = "C"
			}
			return Response{OK: true, State: f.state}, nil
		}
		if f.corruptState {
			f.state = "C"
		}
		return Response{OK: false, Error: "illegal action " + action, State: f.state}, nil
	}
	if f.wrongNext && next == "C" {
		next = "A"
	}
	f.state = next
	return Response{OK: true, State: f.state}, nil
}

func (f *fakeAdapter) State() (Response, error) {
	return Response{OK: true, State: f.state}, nil
}

func (f *fakeAdapter) Close() error { return nil }

func runWith(t *testing.T, ad Adapter, maxSteps int) Report {
	t.Helper()
	m := testModel(t)
	plan := NewExplorer(m).Generate(maxSteps)
	return NewRunner(m, ad).Run(plan, maxSteps)
}

func TestRunCorrectImplementationPasses(t *testing.T) {
	rep := runWith(t, newFakeAdapter(), 3)
	if rep.Verdict != "PASS" {
		t.Fatalf("verdict = %s, failures = %v", rep.Verdict, rep.Failures)
	}
	if !rep.Closed {
		t.Fatal("budget should be closed")
	}
	// Illegal probes: A,B reachable in <3 steps, C at distance 2 < 3 too.
	if len(rep.Illegal) == 0 {
		t.Fatal("expected illegal probes")
	}
	for _, ir := range rep.Illegal {
		if !ir.Rejected || !ir.Unchanged {
			t.Fatalf("illegal probe %+v not rejected/unchanged", ir)
		}
		if len(ir.Calls) == 0 {
			t.Fatalf("illegal probe %+v recorded no actual calls", ir)
		}
	}
	// Actual call outputs must be retained for every sequence.
	for _, sr := range rep.Sequences {
		if len(sr.Calls) != len(sr.Actions)+1 { // reset + applies
			t.Fatalf("sequence %v recorded %d calls", sr.Actions, len(sr.Calls))
		}
	}
}

func TestRunDetectsStateMismatch(t *testing.T) {
	ad := newFakeAdapter()
	ad.wrongNext = true
	rep := runWith(t, ad, 3)
	if rep.Verdict != "FAIL" {
		t.Fatalf("verdict = %s, want FAIL", rep.Verdict)
	}
	joined := strings.Join(rep.Failures, "\n")
	if !strings.Contains(joined, `state: want "C" got "A"`) {
		t.Fatalf("failures lack state diff:\n%s", joined)
	}
}

func TestRunDetectsAcceptedIllegalAction(t *testing.T) {
	ad := newFakeAdapter()
	ad.acceptBad = true
	rep := runWith(t, ad, 3)
	if rep.Verdict != "FAIL" {
		t.Fatalf("verdict = %s, want FAIL", rep.Verdict)
	}
	joined := strings.Join(rep.Failures, "\n")
	if !strings.Contains(joined, "accepted by implementation") {
		t.Fatalf("failures lack illegal-accept note:\n%s", joined)
	}
}

func TestRunDetectsStateChangeOnIllegalAction(t *testing.T) {
	ad := newFakeAdapter()
	ad.corruptState = true // rejects but moves to C
	rep := runWith(t, ad, 3)
	if rep.Verdict != "FAIL" {
		t.Fatalf("verdict = %s, want FAIL", rep.Verdict)
	}
	joined := strings.Join(rep.Failures, "\n")
	if !strings.Contains(joined, "state changed") {
		t.Fatalf("failures lack state-change note:\n%s", joined)
	}
}

func TestRunUnclosedBudgetNeverPasses(t *testing.T) {
	rep := runWith(t, newFakeAdapter(), 2) // ca/cc need 3 steps
	if rep.Verdict == "PASS" {
		t.Fatal("verdict PASS with unclosed budget")
	}
	if rep.Verdict != "INCONCLUSIVE" {
		t.Fatalf("verdict = %s, want INCONCLUSIVE", rep.Verdict)
	}
	if rep.Closed {
		t.Fatal("budget reported closed")
	}
}

func TestDiffStates(t *testing.T) {
	if d := diffStates("A", nil, Response{State: "A"}); d != "" {
		t.Fatalf("equal states diff = %q", d)
	}
	d := diffStates("A", map[string]any{"fare": float64(1)}, Response{State: "B", Data: map[string]any{"fare": float64(2)}})
	if !strings.Contains(d, `state: want "A" got "B"`) || !strings.Contains(d, "data[fare]: want 1 got 2") {
		t.Fatalf("diff = %q", d)
	}
	// Keys not declared by the model are ignored.
	if d := diffStates("A", nil, Response{State: "A", Data: map[string]any{"extra": 1}}); d != "" {
		t.Fatalf("extra key diff = %q", d)
	}
}
