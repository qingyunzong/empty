package sim_test

import (
	"errors"
	"fmt"
	"reflect"
	"testing"

	"sim"
)

// ---- test model: a small job shop -------------------------------------

// source emits jobs via a condition-triggered action whenever the event
// queue is empty and jobs remain.
type source struct {
	remaining int
	sink      *sink
}

func (src *source) Name() string { return "source" }

func (src *source) Triggerable(s *sim.Sim) []sim.Action {
	if src.remaining > 0 {
		return []sim.Action{emitAction{src: src}}
	}
	return nil
}

func (src *source) SaveState() any  { return src.remaining }
func (src *source) LoadState(v any) { src.remaining = v.(int) }

type emitAction struct{ src *source }

func (a emitAction) Describe() string { return "emit job" }

func (a emitAction) Fire(s *sim.Sim) {
	a.src.remaining--
	delay := 1 + s.RNG().Float64()*2
	s.Schedule(delay, "arrive", a.src.sink, arriveHandler)
}

// sink counts completed jobs; it never offers actions.
type sink struct {
	completed int
	reworked  int
}

func (sk *sink) Name() string                        { return "sink" }
func (sk *sink) Triggerable(s *sim.Sim) []sim.Action { return nil }

type sinkState struct{ completed, reworked int }

func (sk *sink) SaveState() any { return sinkState{sk.completed, sk.reworked} }
func (sk *sink) LoadState(v any) {
	st := v.(sinkState)
	sk.completed, sk.reworked = st.completed, st.reworked
}

// arriveHandler draws a random service time and schedules "served".
func arriveHandler(s *sim.Sim, e *sim.Event) {
	service := 0.5 + s.RNG().Float64()
	s.Schedule(service, "served", e.Data, servedHandler)
}

// servedHandler completes the job and, with 30% probability, derives a
// successor "rework" event that loops back into another "served".
func servedHandler(s *sim.Sim, e *sim.Event) {
	sk := e.Data.(*sink)
	sk.completed++
	if s.RNG().Float64() < 0.3 {
		sk.reworked++
		s.Schedule(0.25, "rework", e.Data, func(s *sim.Sim, e *sim.Event) {
			s.Schedule(0.5+s.RNG().Float64(), "served", e.Data, servedHandler)
		})
	}
}

// newShop builds the standard model: n jobs to emit, wired to a sink.
func newShop(seed uint64, n int) (s *sim.Sim, src *source, sk *sink) {
	s = sim.New(seed)
	sk = &sink{}
	src = &source{remaining: n, sink: sk}
	s.Register(src)
	s.Register(sk)
	return s, src, sk
}

// tracer records the execution path for cross-run comparison.
type tracer struct{ lines []string }

func (t *tracer) onEvent(e *sim.Event) {
	t.lines = append(t.lines, fmt.Sprintf("E#%d %s@%g", e.ID, e.Kind, e.Time))
}
func (t *tracer) onAction(c sim.Component, a sim.Action) {
	t.lines = append(t.lines, fmt.Sprintf("A %s:%s", c.Name(), a.Describe()))
}

// ---- tests -------------------------------------------------------------

func TestEventSpawnsSuccessors(t *testing.T) {
	s := sim.New(1)
	var order []string
	s.Schedule(0, "root", nil, func(s *sim.Sim, e *sim.Event) {
		order = append(order, "root")
		s.Schedule(2, "child-late", nil, func(s *sim.Sim, e *sim.Event) {
			order = append(order, "child-late")
		})
		s.Schedule(1, "child-early", nil, func(s *sim.Sim, e *sim.Event) {
			order = append(order, "child-early")
			s.Schedule(0.5, "grandchild", nil, func(s *sim.Sim, e *sim.Event) {
				order = append(order, "grandchild")
			})
		})
	})
	if err := s.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	want := []string{"root", "child-early", "grandchild", "child-late"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	if s.Now() != 2 {
		t.Fatalf("Now = %g, want 2", s.Now())
	}
}

func TestEmptyQueueIsNotAStopCondition(t *testing.T) {
	// No events are ever scheduled up front: the queue is empty at t=0.
	// The source component still has a triggerable action, so the run
	// must not stop; the action derives events that keep it going.
	s, src, sk := newShop(42, 5)

	if err := s.Run(); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if src.remaining != 0 {
		t.Fatalf("remaining = %d, want 0", src.remaining)
	}
	if sk.completed == 0 {
		t.Fatal("no jobs completed; simulation stopped on empty queue")
	}
	if s.Processed() <= 5 {
		t.Fatalf("processed = %d, want > 5 (actions + derived events)", s.Processed())
	}
	// After the run, nothing may remain triggerable or pending.
	if got := len(s.Pending()); got != 0 {
		t.Fatalf("pending events after stop: %d", got)
	}
	if got := len(src.Triggerable(s)); got != 0 {
		t.Fatalf("triggerable actions after stop: %d", got)
	}
}

func TestBudgetExceededGivesPendingEventEvidence(t *testing.T) {
	s, _, _ := newShop(7, 0)
	s.Schedule(1, "e1", nil, func(s *sim.Sim, e *sim.Event) {})
	s.Schedule(2, "e2", nil, func(s *sim.Sim, e *sim.Event) {})
	s.Schedule(3, "e3", nil, func(s *sim.Sim, e *sim.Event) {})
	s.Budget = sim.Budget{MaxEvents: 1}

	err := s.Run()
	var bee *sim.BudgetExceededError
	if !errors.As(err, &bee) {
		t.Fatalf("err = %v, want BudgetExceededError", err)
	}
	if bee.Evidence.Processed != 1 {
		t.Fatalf("processed = %d, want 1", bee.Evidence.Processed)
	}
	if len(bee.Evidence.PendingEvents) != 2 {
		t.Fatalf("pending = %v, want 2 events", bee.Evidence.PendingEvents)
	}
	kinds := map[string]bool{}
	for _, pe := range bee.Evidence.PendingEvents {
		kinds[pe.Kind] = true
	}
	if !kinds["e2"] || !kinds["e3"] {
		t.Fatalf("evidence missing backlog events: %v", bee.Evidence.PendingEvents)
	}
}

type alwaysReady struct{}

func (a *alwaysReady) Name() string { return "always" }
func (a *alwaysReady) Triggerable(s *sim.Sim) []sim.Action {
	return []sim.Action{noopAction{}}
}
func (a *alwaysReady) SaveState() any  { return nil }
func (a *alwaysReady) LoadState(v any) {}

type noopAction struct{}

func (noopAction) Describe() string { return "noop" }
func (noopAction) Fire(s *sim.Sim)  {}

func TestBudgetExceededGivesPendingActionEvidence(t *testing.T) {
	s := sim.New(9)
	s.Register(&alwaysReady{})
	s.Budget = sim.Budget{MaxEvents: 3}

	err := s.Run()
	var bee *sim.BudgetExceededError
	if !errors.As(err, &bee) {
		t.Fatalf("err = %v, want BudgetExceededError", err)
	}
	if len(bee.Evidence.PendingActions) == 0 {
		t.Fatal("evidence has no triggerable-action backlog")
	}
	if bee.Evidence.PendingActions[0] != "always: noop" {
		t.Fatalf("action evidence = %q", bee.Evidence.PendingActions[0])
	}
}

func TestTimeBudgetEvidence(t *testing.T) {
	s := sim.New(3)
	s.Schedule(100, "far-future", nil, func(s *sim.Sim, e *sim.Event) {})
	s.Budget = sim.Budget{MaxTime: 50}

	err := s.Run()
	var bee *sim.BudgetExceededError
	if !errors.As(err, &bee) {
		t.Fatalf("err = %v, want BudgetExceededError", err)
	}
	if len(bee.Evidence.PendingEvents) != 1 || bee.Evidence.PendingEvents[0].Kind != "far-future" {
		t.Fatalf("evidence = %+v", bee.Evidence)
	}
	if s.Now() != 0 {
		t.Fatalf("clock advanced past budget: %g", s.Now())
	}
}

func TestDeterminism(t *testing.T) {
	run := func() []string {
		s, _, sk := newShop(123, 8)
		tr := &tracer{}
		s.OnEvent = tr.onEvent
		s.OnAction = tr.onAction
		if err := s.Run(); err != nil {
			t.Fatalf("Run: %v", err)
		}
		return append(tr.lines, fmt.Sprintf("completed=%d reworked=%d", sk.completed, sk.reworked))
	}
	a, b := run(), run()
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("same seed diverged:\n%v\n%v", a, b)
	}
}

func TestSnapshotRestoreMatchesFullRun(t *testing.T) {
	const seed = 2024
	const jobs = 10
	const pauseAfter = 12

	// Reference: uninterrupted full evolution.
	full, _, fullSink := newShop(seed, jobs)
	fullTrace := &tracer{}
	full.OnEvent = fullTrace.onEvent
	full.OnAction = fullTrace.onAction
	if err := full.Run(); err != nil {
		t.Fatalf("full run: %v", err)
	}
	fullLines := append(fullTrace.lines,
		fmt.Sprintf("completed=%d reworked=%d now=%g", fullSink.completed, fullSink.reworked, full.Now()))

	// Interrupted run: pause via budget, snapshot, restore, continue.
	part, partSrc, partSink := newShop(seed, jobs)
	partTrace := &tracer{}
	part.OnEvent = partTrace.onEvent
	part.OnAction = partTrace.onAction
	part.Budget = sim.Budget{MaxEvents: pauseAfter}

	err := part.Run()
	var bee *sim.BudgetExceededError
	if !errors.As(err, &bee) {
		t.Fatalf("expected budget pause, got %v", err)
	}
	snap := part.Snapshot()

	// Restore into a fresh Sim; the snapshot's RNG state must override
	// the fresh seed so the post-restore evolution matches exactly.
	resumed := sim.New(999)
	resumed.Register(partSrc)
	resumed.Register(partSink)
	resumed.OnEvent = partTrace.onEvent
	resumed.OnAction = partTrace.onAction
	if err := resumed.Restore(snap); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if err := resumed.Run(); err != nil {
		t.Fatalf("resumed run: %v", err)
	}

	partLines := append(partTrace.lines,
		fmt.Sprintf("completed=%d reworked=%d now=%g", partSink.completed, partSink.reworked, resumed.Now()))

	if !reflect.DeepEqual(partLines, fullLines) {
		t.Fatalf("snapshot/resume diverged from full run\nfull:    %v\nresumed: %v", fullLines, partLines)
	}
}

func TestRestoreUnknownComponentFails(t *testing.T) {
	s, _, _ := newShop(5, 1)
	snap := s.Snapshot()
	other := sim.New(5) // no components registered
	if err := other.Restore(snap); err == nil {
		t.Fatal("expected error restoring unregistered component")
	}
}
