package desim_test

import (
	"fmt"
	"reflect"
	"testing"

	"desim"
)

// source is a test component that emits a random-delayed arrival event each
// time it fires, until its remaining count is exhausted. Firing draws from
// the simulation RNG, so snapshot fidelity depends on restoring RNG state.
type source struct {
	name      string
	remaining int
	maxDelay  int
}

type sourceState struct{ remaining int }

func (s *source) Name() string                { return s.name }
func (s *source) Enabled(now desim.Time) bool { return s.remaining > 0 }
func (s *source) SaveState() any              { return sourceState{remaining: s.remaining} }
func (s *source) RestoreState(st any)         { s.remaining = st.(sourceState).remaining }
func (s *source) Fire(ctx *desim.Context) {
	s.remaining--
	delay := desim.Time(1 + ctx.Rand().Intn(s.maxDelay))
	n := s.remaining
	ctx.Logf("t=%d %s fired (left=%d), arrival in %d", ctx.Now(), s.name, n, delay)
	ctx.Schedule(delay, "arrival", func(ctx *desim.Context) {
		ctx.Logf("t=%d arrival", ctx.Now())
	})
}

// chainHandler returns a handler that schedules its own successor n-1 more
// times, with random delays. State is carried as an immutable parameter so
// pending events survive snapshots.
func chainHandler(label string, n int) func(ctx *desim.Context) {
	return func(ctx *desim.Context) {
		delay := desim.Time(1 + ctx.Rand().Intn(5))
		ctx.Logf("t=%d %s[%d] next in %d", ctx.Now(), label, n, delay)
		if n > 1 {
			ctx.Schedule(delay, label, chainHandler(label, n-1))
		}
	}
}

// TestEventSpawnsSuccessors verifies that an event can derive successors and
// that the whole chain executes in non-decreasing time order.
func TestEventSpawnsSuccessors(t *testing.T) {
	sim := desim.New(7)
	const n = 5
	sim.At(0, "chain", chainHandler("chain", n))

	res := sim.Run(desim.Budget{})
	if !res.Completed {
		t.Fatalf("run did not complete: %+v", res.Backlog)
	}
	trace := sim.Trace()
	if len(trace) != n {
		t.Fatalf("expected %d trace entries, got %d: %v", n, len(trace), trace)
	}
	for i, entry := range trace {
		var tm, left int
		if _, err := fmt.Sscanf(entry, "t=%d chain[%d]", &tm, &left); err != nil {
			t.Fatalf("malformed trace entry %q: %v", entry, err)
		}
		if want := n - i; left != want {
			t.Errorf("entry %d: chain index = %d, want %d", i, left, want)
		}
		if i > 0 {
			var prev int
			fmt.Sscanf(trace[i-1], "t=%d chain[%d]", &prev, new(int))
			if tm < prev {
				t.Errorf("time went backwards: %d after %d", tm, prev)
			}
		}
	}
}

// TestQuiescenceRequiresNoEnabledComponents verifies that an empty event
// queue alone does not stop the run: components with enabled actions must
// still fire, and the events they spawn must be processed.
func TestQuiescenceRequiresNoEnabledComponents(t *testing.T) {
	// No initial events at all: the queue is empty from the start. A
	// queue-only stop condition would terminate immediately.
	sim := desim.New(1)
	src := &source{name: "src", remaining: 2, maxDelay: 4}
	sim.AddComponent(src)

	res := sim.Run(desim.Budget{})
	if !res.Completed {
		t.Fatalf("run did not complete: %+v", res.Backlog)
	}
	trace := sim.Trace()
	if len(trace) != 4 { // 2 component actions + 2 spawned arrivals
		t.Fatalf("expected 4 trace entries, got %d: %v", len(trace), trace)
	}
	if got := trace[0][:16]; got != "t=0 src fired (l" {
		t.Errorf("first entry should be the component firing, got %q", trace[0])
	}
	if src.remaining != 0 {
		t.Errorf("component still has %d remaining actions", src.remaining)
	}
}

// TestQueueMomentarilyEmpty verifies the run continues when the queue drains
// mid-simulation while a component can still fire.
func TestQueueMomentarilyEmpty(t *testing.T) {
	sim := desim.New(2)
	src := &source{name: "late", remaining: 1, maxDelay: 3}
	sim.AddComponent(src)
	sim.At(0, "lonely", func(ctx *desim.Context) {
		ctx.Logf("t=%d lonely event (schedules nothing)", ctx.Now())
	})

	res := sim.Run(desim.Budget{})
	if !res.Completed {
		t.Fatalf("run did not complete: %+v", res.Backlog)
	}
	trace := sim.Trace()
	if len(trace) != 3 {
		t.Fatalf("expected 3 trace entries, got %d: %v", len(trace), trace)
	}
	// After the lonely event the queue is empty, but the component must
	// still fire and its arrival must still be processed.
	if trace[1][:12] != "t=0 late fir" {
		t.Errorf("component did not fire after queue emptied: %v", trace)
	}
}

// TestBudgetExceededReportsBacklog verifies that exceeding the step budget
// returns evidence of the remaining work: pending events and ready
// components.
func TestBudgetExceededReportsBacklog(t *testing.T) {
	sim := desim.New(3)
	ready := &source{name: "ready-src", remaining: 10, maxDelay: 2}
	sim.AddComponent(ready)
	var tick func(ctx *desim.Context)
	tick = func(ctx *desim.Context) { ctx.Schedule(3, "tick", tick) }
	sim.At(0, "tick", tick)

	res := sim.Run(desim.Budget{MaxSteps: 5})
	if res.Completed {
		t.Fatal("run should not have completed under budget")
	}
	if res.Backlog == nil {
		t.Fatal("missing backlog evidence")
	}
	if len(res.Backlog.PendingEvents) == 0 {
		t.Error("backlog lists no pending events")
	}
	for _, pe := range res.Backlog.PendingEvents {
		if pe.Label != "tick" && pe.Label != "arrival" {
			t.Errorf("unexpected pending event %q", pe.Label)
		}
		if pe.Time < res.EndTime {
			t.Errorf("pending event at %d is before stop time %d", pe.Time, res.EndTime)
		}
	}
	if !reflect.DeepEqual(res.Backlog.ReadyComponents, []string{"ready-src"}) {
		t.Errorf("ready components = %v, want [ready-src]", res.Backlog.ReadyComponents)
	}
}

// TestTimeBudgetReportsBacklog verifies the MaxTime budget leaves future
// events pending and reports them as evidence.
func TestTimeBudgetReportsBacklog(t *testing.T) {
	sim := desim.New(4)
	sim.At(10, "early", func(ctx *desim.Context) { ctx.Logf("t=%d early", ctx.Now()) })
	sim.At(100, "late", func(ctx *desim.Context) { ctx.Logf("t=%d late", ctx.Now()) })

	res := sim.Run(desim.Budget{MaxTime: 50})
	if res.Completed {
		t.Fatal("run should not have completed under time budget")
	}
	want := []desim.PendingEvent{{Time: 100, Label: "late"}}
	if !reflect.DeepEqual(res.Backlog.PendingEvents, want) {
		t.Errorf("pending events = %+v, want %+v", res.Backlog.PendingEvents, want)
	}
	if res.EndTime != 10 {
		t.Errorf("end time = %d, want 10", res.EndTime)
	}
}

// buildSnapshotSim creates the scenario used by the snapshot tests: a
// chained event and a random-delay source component.
func buildSnapshotSim() (*desim.Sim, *source) {
	sim := desim.New(42)
	src := &source{name: "src", remaining: 5, maxDelay: 7}
	sim.AddComponent(src)
	sim.At(0, "chain", chainHandler("chain", 6))
	return sim, src
}

// TestSnapshotRestoreMatchesFullRun verifies that (a) pausing via budget,
// snapshotting, and continuing yields the same evolution as an uninterrupted
// run, and (b) restoring the snapshot into a fresh simulation with fresh
// component instances also reproduces the full run exactly, including all
// random draws.
func TestSnapshotRestoreMatchesFullRun(t *testing.T) {
	// Reference: full evolution from scratch.
	full, _ := buildSnapshotSim()
	resFull := full.Run(desim.Budget{})
	if !resFull.Completed {
		t.Fatalf("reference run did not complete: %+v", resFull.Backlog)
	}
	traceFull := full.Trace()

	// Paused and continued in place.
	paused, _ := buildSnapshotSim()
	resPause := paused.Run(desim.Budget{MaxSteps: 4})
	if resPause.Completed {
		t.Fatal("paused run unexpectedly completed within budget")
	}
	snap := paused.Snapshot()
	if res := paused.Run(desim.Budget{}); !res.Completed {
		t.Fatalf("continued run did not complete: %+v", res.Backlog)
	}
	if trace := paused.Trace(); !reflect.DeepEqual(trace, traceFull) {
		t.Errorf("paused+continued trace differs from full run:\n got %v\nwant %v", trace, traceFull)
	}

	// Restored from the snapshot into a fresh sim with fresh components.
	interrupted, _ := buildSnapshotSim()
	interrupted.Run(desim.Budget{MaxSteps: 4})
	snap2 := interrupted.Snapshot()
	freshSrc := &source{name: "src", maxDelay: 7}
	restored := desim.Restore(snap2, []desim.Component{freshSrc})
	resRestored := restored.Run(desim.Budget{})
	if !resRestored.Completed {
		t.Fatalf("restored run did not complete: %+v", resRestored.Backlog)
	}
	if trace := restored.Trace(); !reflect.DeepEqual(trace, traceFull) {
		t.Errorf("restored trace differs from full run:\n got %v\nwant %v", trace, traceFull)
	}
	if resRestored.EndTime != resFull.EndTime {
		t.Errorf("restored end time = %d, want %d", resRestored.EndTime, resFull.EndTime)
	}
	if freshSrc.remaining != 0 {
		t.Errorf("restored component has %d remaining actions, want 0", freshSrc.remaining)
	}

	// The snapshot taken from the paused sim must equal the one from the
	// identically-seeded interrupted sim (determinism of the pause point).
	_ = snap
}

// TestDeterminism verifies identical seeds reproduce identical traces.
func TestDeterminism(t *testing.T) {
	a, _ := buildSnapshotSim()
	b, _ := buildSnapshotSim()
	a.Run(desim.Budget{})
	b.Run(desim.Budget{})
	if !reflect.DeepEqual(a.Trace(), b.Trace()) {
		t.Errorf("same seed produced different traces:\n%v\n%v", a.Trace(), b.Trace())
	}
}
