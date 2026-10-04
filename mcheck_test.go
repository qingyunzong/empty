package mcheck

import (
	"strings"
	"testing"
)

// reorderSpec models a node that must receive "a" before "b";
// receiving "b" first and then "a" is a safety violation.
func reorderSpec() Spec {
	return Spec{
		Nodes: []string{"init"},
		Inbox: []Message{{To: 0, Kind: "a"}, {To: 0, Kind: "b"}},
		Table: Table{
			"init": {"a": {Next: "gotA"}, "b": {Next: "half"}},
			"gotA": {"b": {Next: "ok"}},
			"half": {"a": {Next: "bad"}},
		},
		Safety: func(v View) bool { return v.Nodes[0] != "bad" },
	}
}

func TestReorderFindsShortestCounterexample(t *testing.T) {
	res, err := Check(reorderSpec())
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != Violation {
		t.Fatalf("outcome = %v, want violation", res.Outcome)
	}
	if len(res.Trace) != 2 {
		t.Fatalf("trace length = %d, want shortest length 2: %v", len(res.Trace), res.Trace)
	}
	if res.Trace[0].Kind != Deliver || res.Trace[0].Msg.Kind != "b" {
		t.Fatalf("first event = %v, want deliver b", res.Trace[0])
	}
	if !Replay(reorderSpec(), res.Trace).Accepts() {
		t.Fatalf("certificate %v rejected by replay", res.Trace)
	}
}

func TestSafeOrderAcceptedByReplayButNotACertificate(t *testing.T) {
	spec := reorderSpec()
	trace := []Event{
		{Kind: Deliver, Msg: Message{To: 0, Kind: "a"}},
		{Kind: Deliver, Msg: Message{To: 0, Kind: "b"}},
	}
	r := Replay(spec, trace)
	if !r.Legal {
		t.Fatalf("safe order should be legal: %v", r.Err)
	}
	if r.Accepts() {
		t.Fatalf("safe order must not be accepted as a certificate")
	}
}

// dupSpec violates safety only if "ping" is delivered twice.
func dupSpec(allowDup bool) Spec {
	return Spec{
		Nodes: []string{"s0"},
		Inbox: []Message{{To: 0, Kind: "ping"}},
		Table: Table{
			"s0": {"ping": {Next: "s1"}},
			"s1": {"ping": {Next: "bad"}},
		},
		Safety:   func(v View) bool { return v.Nodes[0] != "bad" },
		AllowDup: allowDup,
	}
}

func TestDuplicationRequired(t *testing.T) {
	res, err := Check(dupSpec(false))
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != Safe {
		t.Fatalf("without duplication outcome = %v, want safe", res.Outcome)
	}

	spec := dupSpec(true)
	res, err = Check(spec)
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != Violation {
		t.Fatalf("with duplication outcome = %v, want violation", res.Outcome)
	}
	if len(res.Trace) != 2 || res.Trace[0].Kind != Duplicate {
		t.Fatalf("trace = %v, want [duplicate ping, deliver ping]", res.Trace)
	}
	if !Replay(spec, res.Trace).Accepts() {
		t.Fatalf("certificate %v rejected by replay", res.Trace)
	}
}

// crashSpec violates safety only if node 1 crashes while node 0 waits.
func crashSpec(allowCrash bool) Spec {
	return Spec{
		Nodes: []string{"idle", "up"},
		Inbox: []Message{{To: 0, Kind: "start"}},
		Table: Table{
			"idle": {"start": {Next: "waiting"}},
		},
		Safety: func(v View) bool {
			return !(v.Crashed[1] && v.Nodes[0] == "waiting")
		},
		AllowCrash: allowCrash,
	}
}

func TestCrashRequired(t *testing.T) {
	res, err := Check(crashSpec(false))
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != Safe {
		t.Fatalf("without crash outcome = %v, want safe", res.Outcome)
	}

	spec := crashSpec(true)
	res, err = Check(spec)
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != Violation {
		t.Fatalf("with crash outcome = %v, want violation", res.Outcome)
	}
	if len(res.Trace) != 2 || res.Trace[1].Kind != Crash || res.Trace[1].Node != 1 {
		t.Fatalf("trace = %v, want [deliver start, crash n1]", res.Trace)
	}
	if !Replay(spec, res.Trace).Accepts() {
		t.Fatalf("certificate %v rejected by replay", res.Trace)
	}
}

func TestBudgetExhaustedDiffersFromSafe(t *testing.T) {
	// Every delivery forks two new messages, so the in-flight
	// multiset grows forever and the state space never closes; any
	// depth budget must report BudgetExhausted, never Safe.
	loop := Spec{
		Nodes: []string{"s"},
		Inbox: []Message{{To: 0, Kind: "tick"}},
		Table: Table{
			"s": {"tick": {Send: []Message{{To: 0, Kind: "tick"}, {To: 0, Kind: "tick"}}}},
		},
		Safety:   func(View) bool { return true },
		MaxDepth: 4,
	}
	res, err := Check(loop)
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != BudgetExhausted {
		t.Fatalf("loop outcome = %v, want budget-exhausted", res.Outcome)
	}

	// The reorder spec fully closes with depth >= 2; with depth 1 the
	// budget cuts the search before closure.
	shallow := reorderSpec()
	shallow.MaxDepth = 1
	res, err = Check(shallow)
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != BudgetExhausted {
		t.Fatalf("shallow outcome = %v, want budget-exhausted", res.Outcome)
	}

	deep := reorderSpec()
	deep.MaxDepth = 8
	res, err = Check(deep)
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != Violation {
		t.Fatalf("deep outcome = %v, want violation", res.Outcome)
	}

	// A terminating safe spec closes within budget and reports Safe.
	safe := dupSpec(false)
	safe.MaxDepth = 4
	res, err = Check(safe)
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != Safe {
		t.Fatalf("terminating outcome = %v, want safe", res.Outcome)
	}
}

func TestMaxStatesBudget(t *testing.T) {
	loop := Spec{
		Nodes: []string{"s"},
		Inbox: []Message{{To: 0, Kind: "tick"}},
		Table: Table{
			"s": {"tick": {Send: []Message{{To: 0, Kind: "tick"}, {To: 0, Kind: "tick"}}}},
		},
		Safety:    func(View) bool { return true },
		MaxStates: 3,
	}
	res, err := Check(loop)
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != BudgetExhausted {
		t.Fatalf("outcome = %v, want budget-exhausted", res.Outcome)
	}
}

func TestReplayRejectsIllegalTraces(t *testing.T) {
	spec := reorderSpec()
	cases := map[string][]Event{
		"message not in flight": {
			{Kind: Deliver, Msg: Message{To: 0, Kind: "zzz"}},
		},
		"double delivery of one copy": {
			{Kind: Deliver, Msg: Message{To: 0, Kind: "a"}},
			{Kind: Deliver, Msg: Message{To: 0, Kind: "a"}},
		},
		"unknown node": {
			{Kind: Deliver, Msg: Message{To: 7, Kind: "a"}},
		},
	}
	for name, trace := range cases {
		if r := Replay(spec, trace); r.Legal {
			t.Errorf("%s: replay accepted illegal trace", name)
		}
	}

	dup := dupSpec(false)
	r := Replay(dup, []Event{{Kind: Duplicate, Msg: Message{To: 0, Kind: "ping"}}})
	if r.Legal {
		t.Errorf("replay allowed duplication without AllowDup")
	}

	crash := crashSpec(true)
	r = Replay(crash, []Event{{Kind: Crash, Node: 1}, {Kind: Crash, Node: 0}})
	if r.Legal {
		t.Errorf("replay allowed a second crash beyond budget")
	}
	if r.Err == nil || !strings.Contains(r.Err.Error(), "budget") {
		t.Errorf("second crash error = %v, want budget mention", r.Err)
	}
}

func TestValidation(t *testing.T) {
	spec := reorderSpec()
	spec.Inbox = make([]Message, MaxMessages+1)
	if _, err := Check(spec); err == nil {
		t.Fatalf("Check accepted %d initial messages, limit is %d", MaxMessages+1, MaxMessages)
	}

	spec = reorderSpec()
	spec.Inbox = []Message{{To: 3, Kind: "a"}}
	if _, err := Check(spec); err == nil {
		t.Fatalf("Check accepted message to unknown node")
	}

	spec = reorderSpec()
	spec.Safety = nil
	if _, err := Check(spec); err == nil {
		t.Fatalf("Check accepted nil Safety")
	}
}

func TestInitialStateViolation(t *testing.T) {
	spec := reorderSpec()
	spec.Safety = func(View) bool { return false }
	res, err := Check(spec)
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != Violation || len(res.Trace) != 0 {
		t.Fatalf("outcome = %v trace = %v, want immediate violation", res.Outcome, res.Trace)
	}
	if !Replay(spec, res.Trace).Accepts() {
		t.Fatalf("empty certificate rejected")
	}
}

func TestSentMessagesBecomeDeliverable(t *testing.T) {
	// Node 0 forwards "go" to node 1; only then may node 1 receive it.
	spec := Spec{
		Nodes: []string{"ready", "idle"},
		Inbox: []Message{{To: 0, Kind: "go"}},
		Table: Table{
			"ready": {"go": {Next: "done", Send: []Message{{To: 1, Kind: "wake"}}}},
			"idle":  {"wake": {Next: "bad"}},
		},
		Safety: func(v View) bool { return v.Nodes[1] != "bad" },
	}
	res, err := Check(spec)
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != Violation || len(res.Trace) != 2 {
		t.Fatalf("outcome = %v trace = %v, want 2-event violation", res.Outcome, res.Trace)
	}
	if !Replay(spec, res.Trace).Accepts() {
		t.Fatalf("certificate %v rejected by replay", res.Trace)
	}
}
