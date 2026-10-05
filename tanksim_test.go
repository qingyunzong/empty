package tanksim

import (
	"errors"
	"math/big"
	"strings"
	"testing"
)

func mustSim(t *testing.T, tanks []Tank, valves []Valve, triggers []Trigger) *Sim {
	t.Helper()
	s, err := NewSim(tanks, valves, triggers)
	if err != nil {
		t.Fatalf("NewSim: %v", err)
	}
	return s
}

func checkLevel(t *testing.T, s *Sim, tank string, want *big.Rat) {
	t.Helper()
	if got := s.Level(tank); got.Cmp(want) != 0 {
		t.Fatalf("tank %s level = %s, want %s", tank, got.RatString(), want.RatString())
	}
}

func TestExactRationalRates(t *testing.T) {
	s := mustSim(t,
		[]Tank{{ID: "A", Capacity: Rat(10, 1), Level: Rat(0, 1)}},
		[]Valve{
			{ID: "in", From: "", To: "A", Rate: Rat(1, 3), Open: true},
			{ID: "out", From: "A", To: "", Rate: Rat(1, 6), Open: true},
		}, nil)
	if err := s.Run(Rat(12, 1)); err != nil {
		t.Fatal(err)
	}
	checkLevel(t, s, "A", Rat(2, 1)) // (1/3 - 1/6) * 12 = 2 exactly
	if err := s.Run(Rat(30, 1)); err != nil {
		t.Fatal(err)
	}
	checkLevel(t, s, "A", Rat(5, 1))
	if got := s.Time(); got.Cmp(Rat(30, 1)) != 0 {
		t.Fatalf("time = %s, want 30", got.RatString())
	}
}

func TestEmptyBoundaryLimitsFlow(t *testing.T) {
	s := mustSim(t,
		[]Tank{
			{ID: "A", Capacity: Rat(10, 1), Level: Rat(1, 1)},
			{ID: "B", Capacity: Rat(100, 1), Level: Rat(0, 1)},
		},
		[]Valve{
			{ID: "ab", From: "A", To: "B", Rate: Rat(2, 1), Open: true},
			{ID: "bsink", From: "B", To: "", Rate: Rat(1, 1), Open: true},
		}, nil)
	// A empties at t=1/2; B gained 2t and lost t, so B = 1/2.
	if err := s.Run(Rat(1, 2)); err != nil {
		t.Fatal(err)
	}
	checkLevel(t, s, "A", Rat(0, 1))
	checkLevel(t, s, "B", Rat(1, 2))
	// After A is empty its outflow is limited to zero; B drains at rate 1
	// and is empty at t=1.
	if err := s.Run(Rat(2, 1)); err != nil {
		t.Fatal(err)
	}
	checkLevel(t, s, "A", Rat(0, 1))
	checkLevel(t, s, "B", Rat(0, 1))
}

func TestFullBoundaryLimitsFlow(t *testing.T) {
	s := mustSim(t,
		[]Tank{
			{ID: "A", Capacity: Rat(2, 1), Level: Rat(1, 1)},
			{ID: "B", Capacity: Rat(10, 1), Level: Rat(0, 1)},
		},
		[]Valve{
			{ID: "src", From: "", To: "A", Rate: Rat(3, 1), Open: true},
			{ID: "ab", From: "A", To: "B", Rate: Rat(1, 1), Open: true},
		}, nil)
	// A fills at net rate 2 and is full at t=1/2; B got 1/2.
	if err := s.Run(Rat(1, 2)); err != nil {
		t.Fatal(err)
	}
	checkLevel(t, s, "A", Rat(2, 1))
	checkLevel(t, s, "B", Rat(1, 2))
	// Once full, inflow is limited to outflow (1); A stays at capacity.
	if err := s.Run(Rat(2, 1)); err != nil {
		t.Fatal(err)
	}
	checkLevel(t, s, "A", Rat(2, 1))
	checkLevel(t, s, "B", Rat(2, 1))
}

func TestThresholdSwitchExact(t *testing.T) {
	s := mustSim(t,
		[]Tank{{ID: "A", Capacity: Rat(10, 1), Level: Rat(0, 1)}},
		[]Valve{
			{ID: "in", From: "", To: "A", Rate: Rat(1, 1), Open: true},
			{ID: "out", From: "A", To: "", Rate: Rat(2, 1), Open: false},
		},
		[]Trigger{
			{ID: "T1", Cond: CondRising, Tank: "A", Threshold: Rat(4, 1), Act: ActClose, ActValve: "in"},
			{ID: "T2", Cond: CondRising, Tank: "A", Threshold: Rat(4, 1), Act: ActOpen, ActValve: "out"},
		})
	if err := s.Run(Rat(10, 1)); err != nil {
		t.Fatal(err)
	}
	// Fills to 4 at t=4, drains at rate 2, empty at t=6, stays empty.
	checkLevel(t, s, "A", Rat(0, 1))
	evs := s.Events()
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	ev := evs[0]
	if ev.Time.Cmp(Rat(4, 1)) != 0 {
		t.Fatalf("event time = %s, want 4", ev.Time.RatString())
	}
	if len(ev.Fired) != 2 || ev.Fired[0] != "T1" || ev.Fired[1] != "T2" {
		t.Fatalf("fired = %v, want [T1 T2] in one tick", ev.Fired)
	}
	if ev.Levels["A"].Cmp(Rat(4, 1)) != 0 {
		t.Fatalf("event level = %s, want exactly 4", ev.Levels["A"].RatString())
	}
	if ev.Valves["in"] || !ev.Valves["out"] {
		t.Fatalf("valves after event = %v, want in closed, out open", ev.Valves)
	}
}

// Both triggers watching the same threshold must be settled before any
// switch is applied: both fire in the same iteration, and their actions are
// applied in declaration order (close, then toggle -> net open).
func TestSameTickSettleBeforeSwitch(t *testing.T) {
	s := mustSim(t,
		[]Tank{{ID: "A", Capacity: Rat(10, 1), Level: Rat(0, 1)}},
		[]Valve{{ID: "in", From: "", To: "A", Rate: Rat(1, 1), Open: true}},
		[]Trigger{
			{ID: "T1", Cond: CondRising, Tank: "A", Threshold: Rat(4, 1), Act: ActClose, ActValve: "in"},
			{ID: "T2", Cond: CondRising, Tank: "A", Threshold: Rat(4, 1), Act: ActToggle, ActValve: "in"},
		})
	if err := s.Run(Rat(10, 1)); err != nil {
		t.Fatal(err)
	}
	evs := s.Events()
	if len(evs) != 1 || evs[0].Iter != 0 || len(evs[0].Fired) != 2 {
		t.Fatalf("events = %+v, want one tick settling both triggers", evs)
	}
	if !s.ValveOpen("in") {
		t.Fatal("valve should be open after close-then-toggle in the same tick")
	}
	checkLevel(t, s, "A", Rat(10, 1)) // flow never stopped
}

// A valve-condition trigger cascades within the same tick: T1 opens "out",
// which immediately activates T2, all at t=2.
func TestCascadeSettlesAtSameTick(t *testing.T) {
	s := mustSim(t,
		[]Tank{{ID: "A", Capacity: Rat(10, 1), Level: Rat(0, 1)}},
		[]Valve{
			{ID: "in", From: "", To: "A", Rate: Rat(1, 1), Open: true},
			{ID: "out", From: "A", To: "", Rate: Rat(5, 1), Open: false},
		},
		[]Trigger{
			{ID: "T1", Cond: CondRising, Tank: "A", Threshold: Rat(2, 1), Act: ActOpen, ActValve: "out"},
			{ID: "T2", Cond: CondValveOpen, Valve: "out", Act: ActClose, ActValve: "in"},
		})
	if err := s.Run(Rat(3, 1)); err != nil {
		t.Fatal(err)
	}
	evs := s.Events()
	if len(evs) != 2 {
		t.Fatalf("got %d events, want 2 (cascade iterations)", len(evs))
	}
	for i, ev := range evs {
		if ev.Time.Cmp(Rat(2, 1)) != 0 {
			t.Fatalf("event %d time = %s, want 2 (zero-time cascade)", i, ev.Time.RatString())
		}
		if ev.Iter != i {
			t.Fatalf("event %d iter = %d", i, ev.Iter)
		}
	}
	// After the cascade: net -5 from level 2, empty at t=12/5.
	checkLevel(t, s, "A", Rat(0, 1))
}

func TestInitialConditionSettlesAtStart(t *testing.T) {
	s := mustSim(t,
		[]Tank{{ID: "A", Capacity: Rat(10, 1), Level: Rat(5, 1)}},
		[]Valve{{ID: "in", From: "", To: "A", Rate: Rat(1, 1), Open: true}},
		[]Trigger{
			{ID: "T1", Cond: CondRising, Tank: "A", Threshold: Rat(4, 1), Act: ActClose, ActValve: "in"},
		})
	if err := s.Run(Rat(3, 1)); err != nil {
		t.Fatal(err)
	}
	evs := s.Events()
	if len(evs) != 1 || evs[0].Time.Sign() != 0 {
		t.Fatalf("events = %+v, want one event at t=0", evs)
	}
	checkLevel(t, s, "A", Rat(5, 1))
}

func TestZeroTimeLoopReportsEvidence(t *testing.T) {
	s := mustSim(t,
		[]Tank{{ID: "A", Capacity: Rat(1, 1), Level: Rat(0, 1)}},
		[]Valve{
			{ID: "v1", From: "", To: "A", Rate: Rat(1, 1), Open: true},
			{ID: "v2", From: "A", To: "", Rate: Rat(1, 1), Open: false},
		},
		[]Trigger{
			{ID: "T1", Cond: CondValveOpen, Valve: "v1", Act: ActOpen, ActValve: "v2"},
			{ID: "T2", Cond: CondValveOpen, Valve: "v2", Act: ActClose, ActValve: "v1"},
			{ID: "T3", Cond: CondValveClosed, Valve: "v1", Act: ActOpen, ActValve: "v1"},
		})
	err := s.Run(Rat(1, 1))
	if err == nil {
		t.Fatal("expected zero-time loop error")
	}
	var loop *ZeroTimeLoopError
	if !errors.As(err, &loop) {
		t.Fatalf("error type = %T, want *ZeroTimeLoopError", err)
	}
	if loop.Time.Sign() != 0 {
		t.Fatalf("loop time = %s, want 0", loop.Time.RatString())
	}
	// Evidence: iter0 T1 (v2 opens), iter1 T2 (v1 closes), iter2 T3 (v1
	// reopens) -> configuration of iter1 repeats.
	if len(loop.Trace) != 3 {
		t.Fatalf("trace has %d iterations, want 3", len(loop.Trace))
	}
	wantFired := [][]string{{"T1"}, {"T2"}, {"T3"}}
	for i, ev := range loop.Trace {
		if len(ev.Fired) != 1 || ev.Fired[0] != wantFired[i][0] {
			t.Fatalf("trace iter %d fired = %v, want %v", i, ev.Fired, wantFired[i])
		}
		if ev.Time.Sign() != 0 {
			t.Fatalf("trace iter %d time = %s, want 0", i, ev.Time.RatString())
		}
	}
	if loop.RepeatedIter != 1 {
		t.Fatalf("repeated iteration = %d, want 1", loop.RepeatedIter)
	}
	msg := err.Error()
	for _, want := range []string{"zero-time loop", "t=0", "T1", "T2", "T3", "v1=open", "v1=closed"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("error message missing %q:\n%s", want, msg)
		}
	}
}
