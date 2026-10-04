package protocheck

import (
	"reflect"
	"strings"
	"testing"
)

func TestRunPassShortestHistory(t *testing.T) {
	tab := doorTable()
	rep := Run(tab, NewSimAdapter(tab), Options{Goal: "locked", MaxSteps: 3, CheckIllegal: true})
	if rep.Verdict != VerdictPass {
		t.Fatalf("verdict = %s, reason = %s, failures = %v", rep.Verdict, rep.Reason, rep.Failures)
	}
	if !rep.Closed {
		t.Fatal("expected closed budget")
	}
	if !reflect.DeepEqual(rep.History, []string{"lock"}) {
		t.Fatalf("history = %v, want [lock]", rep.History)
	}
	if len(rep.Calls) == 0 {
		t.Fatal("expected recorded adapter calls")
	}
}

func TestRunRecordsActualOutputs(t *testing.T) {
	tab := doorTable()
	rep := Run(tab, NewSimAdapter(tab), Options{Goal: "locked", MaxSteps: 1, CheckIllegal: true})
	var sawReset, sawApply, sawState, sawIllegalErr bool
	for _, c := range rep.Calls {
		switch {
		case c.Op == "reset" && c.Output == "ok":
			sawReset = true
		case c.Op == "apply" && c.Input == "lock" && c.Output == "ok":
			sawApply = true
		case c.Op == "state" && c.Output != "":
			sawState = true
		case c.Op == "apply" && c.Err != "":
			sawIllegalErr = true
		}
	}
	if !sawReset || !sawApply || !sawState || !sawIllegalErr {
		t.Fatalf("missing recorded calls: reset=%v apply=%v state=%v illegalErr=%v\ncalls=%v",
			sawReset, sawApply, sawState, sawIllegalErr, rep.Calls)
	}
}

func TestRunStateDiff(t *testing.T) {
	tab := doorTable()
	sim := NewSimAdapter(tab)
	sim.WrongTo = map[string]string{"closed\x00open": "locked"}
	rep := Run(tab, sim, Options{Goal: "open", MaxSteps: 2, CheckIllegal: false})
	if rep.Verdict != VerdictFail {
		t.Fatalf("verdict = %s, want FAIL", rep.Verdict)
	}
	if len(rep.Diffs) == 0 {
		t.Fatal("expected a recorded state difference")
	}
	if !strings.Contains(rep.Diffs[0], `model state "open"`) {
		t.Fatalf("unexpected diff: %s", rep.Diffs[0])
	}
}

func TestRunIllegalAccepted(t *testing.T) {
	tab := doorTable()
	sim := NewSimAdapter(tab)
	sim.AcceptIllegal = true
	rep := Run(tab, sim, Options{Goal: "locked", MaxSteps: 2, CheckIllegal: true})
	if rep.Verdict != VerdictFail {
		t.Fatalf("verdict = %s, want FAIL", rep.Verdict)
	}
	joined := strings.Join(rep.Failures, "\n")
	if !strings.Contains(joined, "accepted") {
		t.Fatalf("expected 'accepted' failure, got: %v", rep.Failures)
	}
}

func TestRunIllegalChangesState(t *testing.T) {
	tab := doorTable()
	sim := NewSimAdapter(tab)
	sim.IllegalTo = "open"
	rep := Run(tab, sim, Options{Goal: "locked", MaxSteps: 2, CheckIllegal: true})
	if rep.Verdict != VerdictFail {
		t.Fatalf("verdict = %s, want FAIL", rep.Verdict)
	}
	joined := strings.Join(rep.Failures, "\n")
	if !strings.Contains(joined, "changed state") {
		t.Fatalf("expected 'changed state' failure, got: %v", rep.Failures)
	}
}

func TestRunBudgetNotClosedNeverPasses(t *testing.T) {
	tab := doorTable()
	rep := Run(tab, NewSimAdapter(tab), Options{Goal: "locked", MaxSteps: 0, CheckIllegal: false})
	if rep.Verdict == VerdictPass {
		t.Fatal("budget not closed but verdict is PASS")
	}
	if rep.Verdict != VerdictInconclusive {
		t.Fatalf("verdict = %s, want INCONCLUSIVE", rep.Verdict)
	}
	if rep.Closed {
		t.Fatal("closed = true, want false")
	}
	if rep.Found {
		t.Fatal("found = true, want false")
	}
}

func TestRunGoalAtInitialState(t *testing.T) {
	tab := doorTable()
	rep := Run(tab, NewSimAdapter(tab), Options{Goal: "closed", MaxSteps: 0, CheckIllegal: true})
	if rep.Verdict != VerdictPass {
		t.Fatalf("verdict = %s, failures = %v", rep.Verdict, rep.Failures)
	}
	if len(rep.History) != 0 {
		t.Fatalf("history = %v, want empty", rep.History)
	}
}

func TestRunGoalUnreachable(t *testing.T) {
	tab := &Table{
		Initial: "closed",
		States:  []string{"closed", "open", "locked"},
		Transitions: []Transition{
			{Action: "open", From: "closed", To: "open"},
			{Action: "close", From: "open", To: "closed"},
		},
	}
	rep := Run(tab, NewSimAdapter(tab), Options{Goal: "locked", MaxSteps: 4, CheckIllegal: false})
	if rep.Verdict != VerdictFail {
		t.Fatalf("verdict = %s, want FAIL", rep.Verdict)
	}
	if !rep.Closed {
		t.Fatal("expected closed exploration")
	}
	if !strings.Contains(rep.Reason, "unreachable") {
		t.Fatalf("reason = %q, want mention of unreachable", rep.Reason)
	}
}

func TestRunInvalidGoal(t *testing.T) {
	tab := doorTable()
	rep := Run(tab, NewSimAdapter(tab), Options{Goal: "nowhere", MaxSteps: 3})
	if rep.Verdict != VerdictFail {
		t.Fatalf("verdict = %s, want FAIL", rep.Verdict)
	}
}

func TestSimAdapterIllegalDoesNotChangeState(t *testing.T) {
	tab := doorTable()
	sim := NewSimAdapter(tab)
	if err := sim.Apply("unlock"); err == nil {
		t.Fatal("expected error for illegal action")
	}
	s, err := sim.State()
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if s != "closed" {
		t.Fatalf("state = %q after illegal action, want %q", s, "closed")
	}
}
