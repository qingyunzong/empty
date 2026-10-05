package statever

import "testing"

// Model F1: p0 -x-> p1, p1 -y-> p2(bad), p2 -x-> p1.
// Fair lasso: prefix [x], cycle [y,x] (no event is enabled at both p1,p2).
func modelF1(t *testing.T) *Model {
	return parse(t, `{
		"states": ["p0","p1","p2"],
		"initial": "p0",
		"events": ["x","y"],
		"transitions": [
			{"from":"p0","event":"x","to":"p1"},
			{"from":"p1","event":"y","to":"p2"},
			{"from":"p2","event":"x","to":"p1"}
		],
		"bad": ["p2"],
		"budget": 10
	}`)
}

// Model F2: q0 -e-> q1(bad); q1 has self-loops e and f.
// Both e and f are continuously ready at q1, so the shortest fair cycle is
// [e,f]; a cycle of [e] alone would be unfair.
func modelF2(t *testing.T) *Model {
	return parse(t, `{
		"states": ["q0","q1"],
		"initial": "q0",
		"events": ["e","f"],
		"transitions": [
			{"from":"q0","event":"e","to":"q1"},
			{"from":"q1","event":"e","to":"q1"},
			{"from":"q1","event":"f","to":"q1"}
		],
		"bad": ["q1"],
		"budget": 10
	}`)
}

func TestFairViolationFound(t *testing.T) {
	m := modelF1(t)
	res := FairCheck(m)
	if res.Violation == nil {
		t.Fatal("expected fair violation")
	}
	l := res.Violation
	if got := l.Events(); len(got) != 3 || got[0] != 0 || got[1] != 1 || got[2] != 0 {
		t.Fatalf("events = %v, want [x y x] = [0 1 0]", got)
	}
	if len(l.Prefix) != 1 || len(l.Cycle) != 2 {
		t.Fatalf("prefix %d steps, cycle %d steps; want 1 and 2", len(l.Prefix), len(l.Cycle))
	}
	// Independent unrolling check must accept the produced lasso.
	if err := VerifyFairLasso(m, l); err != nil {
		t.Fatalf("VerifyFairLasso rejected produced lasso: %v", err)
	}
}

func TestFairnessForcesContinuouslyReadyEvents(t *testing.T) {
	m := modelF2(t)
	res := FairCheck(m)
	if res.Violation == nil {
		t.Fatal("expected fair violation")
	}
	l := res.Violation
	// Cycle must contain BOTH e(0) and f(1): shortest fair cycle is [e,f].
	if len(l.Cycle) != 2 || l.Cycle[0].Event != 0 || l.Cycle[1].Event != 1 {
		t.Fatalf("cycle events = %v, want [e f]", eventsOf(l.Cycle))
	}
	if err := VerifyFairLasso(m, l); err != nil {
		t.Fatalf("VerifyFairLasso: %v", err)
	}
}

func TestVerifyFairLassoRejectsTampering(t *testing.T) {
	m := modelF2(t)
	good := FairCheck(m).Violation

	// Unfair cycle: drop the f step so continuously-ready f never fires.
	unfair := &Lasso{Prefix: good.Prefix, Cycle: good.Cycle[:1]}
	if err := VerifyFairLasso(m, unfair); err == nil {
		t.Fatal("expected unfairness to be detected")
	}

	// Broken loop closure: point the last step elsewhere.
	broken := &Lasso{Prefix: good.Prefix, Cycle: []Step{
		{From: 1, Event: 0, To: 1},
		{From: 1, Event: 1, To: 0},
	}}
	if err := VerifyFairLasso(m, broken); err == nil {
		t.Fatal("expected loop-closure failure to be detected")
	}

	// Trace that never visits a bad state is not a violation.
	m2 := modelF1(t)
	noBad := &Lasso{
		Prefix: []Step{},
		Cycle:  []Step{{From: 1, Event: 1, To: 2}, {From: 2, Event: 0, To: 1}},
	}
	_ = m2
	// p2 is bad, so build one that truly avoids bad states on F2's q0 loop:
	// q0 has no self loop; instead use F1 without the bad visit is impossible,
	// so check the bad-visit requirement via a cycle on non-bad states only.
	m3 := parse(t, `{"states":["a","b","c"],"initial":"a","events":["x"],
		"transitions":[
			{"from":"a","event":"x","to":"b"},
			{"from":"b","event":"x","to":"a"},
			{"from":"a","event":"x","to":"c"}],
		"bad":["c"],"budget":10}`)
	noBad = &Lasso{Prefix: []Step{}, Cycle: []Step{{From: 0, Event: 0, To: 1}, {From: 1, Event: 0, To: 0}}}
	if err := VerifyFairLasso(m3, noBad); err == nil {
		t.Fatal("expected missing-bad-visit to be detected")
	}
}

func TestNoFairViolationSinksOnly(t *testing.T) {
	// Bad state reachable but is a sink: no infinite fair trace violates.
	m := parse(t, `{"states":["s0","s1"],"initial":"s0","events":["a"],
		"transitions":[{"from":"s0","event":"a","to":"s1"}],
		"bad":["s1"],"budget":10}`)
	res := FairCheck(m)
	if res.Violation != nil {
		t.Fatalf("unexpected violation: %+v", res.Violation)
	}
	if !res.BadReachable {
		t.Fatal("bad state IS reachable (bounded check would flag it)")
	}
	// Complete SCC evidence must be present and cover every state.
	if len(res.Evidence) != 2 {
		t.Fatalf("evidence has %d SCCs, want 2", len(res.Evidence))
	}
	covered := 0
	for _, ev := range res.Evidence {
		covered += len(ev.States)
		if ev.HasFairCycle {
			t.Fatalf("SCC %v unexpectedly has a fair cycle", ev.States)
		}
	}
	if covered != 2 {
		t.Fatalf("evidence covers %d states, want 2", covered)
	}
}

func TestNoFairViolationBadUnreachable(t *testing.T) {
	m := parse(t, `{"states":["s0","s1","s2"],"initial":"s0","events":["a"],
		"transitions":[
			{"from":"s0","event":"a","to":"s1"},
			{"from":"s1","event":"a","to":"s0"}],
		"bad":["s2"],"budget":10}`)
	res := FairCheck(m)
	if res.Violation != nil {
		t.Fatal("unexpected violation")
	}
	if res.BadReachable {
		t.Fatal("bad state must be unreachable")
	}
	// Global safety: bounded check also finds nothing, but only the SCC
	// analysis proves it beyond the budget.
	if BoundedCheck(m).Found() {
		t.Fatal("bounded check should find nothing either")
	}
}

// TestFairCycleIndependentUnrolling cross-checks every produced lasso with
// the independent unrolling verifier, and confirms the cycle states form a
// closed walk inside a single SCC.
func TestFairCycleIndependentUnrolling(t *testing.T) {
	for _, mk := range []func(*testing.T) *Model{modelF1, modelF2} {
		m := mk(t)
		res := FairCheck(m)
		if res.Violation == nil {
			t.Fatal("expected violation")
		}
		if err := VerifyFairLasso(m, res.Violation); err != nil {
			t.Fatalf("unrolling check failed: %v", err)
		}
		_, compOf := CompOf(m)
		entry := res.Violation.Cycle[0].From
		for _, st := range res.Violation.Cycle {
			if compOf[st.From] != compOf[entry] || compOf[st.To] != compOf[entry] {
				t.Fatal("cycle steps must stay within one SCC")
			}
		}
	}
}

// TestBoundedNotGlobal documents the key distinction: a model can be clean
// within the budget yet violate the invariant beyond it.
func TestBoundedNotGlobal(t *testing.T) {
	// Bad state at depth 7; budget 6 sees nothing...
	m := chainModel(t, 8, 6)
	if BoundedCheck(m).Found() {
		t.Fatal("within budget 6 there must be no violation")
	}
	// ...but the fair/SCC analysis is unbounded and finds the lasso:
	// prefix of 7 steps to the bad sink... the sink has no cycle, so use a
	// bad state with a self-loop instead.
	m2 := parse(t, `{"states":["s0","s1","s2","s3","s4","s5","s6","s7"],
		"initial":"s0","events":["go"],
		"transitions":[
			{"from":"s0","event":"go","to":"s1"},
			{"from":"s1","event":"go","to":"s2"},
			{"from":"s2","event":"go","to":"s3"},
			{"from":"s3","event":"go","to":"s4"},
			{"from":"s4","event":"go","to":"s5"},
			{"from":"s5","event":"go","to":"s6"},
			{"from":"s6","event":"go","to":"s7"},
			{"from":"s7","event":"go","to":"s7"}],
		"bad":["s7"],"budget":6}`)
	if BoundedCheck(m2).Found() {
		t.Fatal("budget 6 must not reach s7 at depth 7")
	}
	res := FairCheck(m2)
	if res.Violation == nil {
		t.Fatal("fair analysis must find the violation beyond the budget")
	}
	if len(res.Violation.Prefix) != 7 || len(res.Violation.Cycle) != 1 {
		t.Fatalf("prefix=%d cycle=%d, want 7 and 1",
			len(res.Violation.Prefix), len(res.Violation.Cycle))
	}
	if err := VerifyFairLasso(m2, res.Violation); err != nil {
		t.Fatalf("VerifyFairLasso: %v", err)
	}
}
