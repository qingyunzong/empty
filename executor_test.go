package formal

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestExecuteMixedActionDAG(t *testing.T) {
	backend := &instantBackend{}
	e := newTestExecutor(t, backend)

	rep, err := e.Execute(context.Background(), diamondPlan(1))
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if rep.State != RunSucceeded {
		t.Fatalf("state = %s, want %s (err=%v)", rep.State, RunSucceeded, rep.Err)
	}
	if len(rep.Nodes) != 4 {
		t.Fatalf("got %d node reports, want 4", len(rep.Nodes))
	}
	for _, n := range rep.Nodes {
		if n.State != NodeSucceeded {
			t.Errorf("node %s state = %s, want %s", n.ID, n.State, NodeSucceeded)
		}
		if !n.Effected {
			t.Errorf("node %s should be effective", n.ID)
		}
	}
	if got := backend.applied(); got != 4 {
		t.Errorf("backend applied %d nodes, want 4", got)
	}
	if got := backend.rolledBack(); got != 0 {
		t.Errorf("backend rolled back %d nodes, want 0", got)
	}
}

func TestIndependentNodesRunInParallel(t *testing.T) {
	backend := newHeldBackend()
	e := newTestExecutor(t, backend)

	run, err := e.Start(context.Background(), diamondPlan(1))
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if run.PlanID() != "stack" || run.Generation() != 1 {
		t.Fatalf("run identity = %q/%d, want stack/1", run.PlanID(), run.Generation())
	}

	releaseA := backend.waitForCall(t, 1, "a")
	backend.release(releaseA, okOutcome("a"))

	// b and c are independent. Both must be in flight before either completes;
	// a sequential executor would only ever submit b here.
	releaseB := backend.waitForCall(t, 1, "b")
	releaseC := backend.waitForCall(t, 1, "c")

	backend.release(releaseC, okOutcome("c"))
	backend.release(releaseB, okOutcome("b"))

	releaseD := backend.waitForCall(t, 1, "d")
	backend.release(releaseD, okOutcome("d"))

	rep := waitReport(t, run)
	if rep.State != RunSucceeded {
		t.Fatalf("state = %s, want %s (err=%v)", rep.State, RunSucceeded, rep.Err)
	}
	select {
	case <-run.Done():
	default:
		t.Fatal("Done is not closed after Wait returned")
	}
}

func TestExecuteReturnsFailedReportWithoutWaitError(t *testing.T) {
	backend := newScriptedBackend(map[string]faultMode{
		"a": faultBeforeEffect,
		"b": faultOK,
		"c": faultOK,
		"d": faultOK,
	}, nil, false)
	e := newTestExecutor(t, backend)
	rep, err := e.Execute(context.Background(), diamondPlan(1))
	if err != nil {
		t.Fatalf("Execute returned wait error: %v", err)
	}
	if rep.State != RunFailed {
		t.Fatalf("state = %s, want %s", rep.State, RunFailed)
	}
	if rep.Err == nil {
		t.Fatal("failed report has nil plan error")
	}
}

func TestGenerationFencingRejectsStaleCallbacks(t *testing.T) {
	backend := newHeldBackend()
	e := newTestExecutor(t, backend)

	run1, err := e.Start(context.Background(), diamondPlan(1))
	if err != nil {
		t.Fatalf("Start generation 1: %v", err)
	}
	staleA := backend.waitForCall(t, 1, "a")

	run2, err := e.Start(context.Background(), diamondPlan(2))
	if err != nil {
		t.Fatalf("Start generation 2: %v", err)
	}
	currentA := backend.waitForCall(t, 2, "a")

	// A late completion from generation 1 must not advance generation 2.
	backend.release(staleA, okOutcome("a"))
	time.Sleep(30 * time.Millisecond)

	select {
	case <-run2.Done():
		t.Fatal("generation 2 settled before its own callback arrived")
	default:
	}
	if got := backend.applyCount(2); got != 1 {
		t.Fatalf("generation 2 applied %d nodes after stale callback, want 1", got)
	}
	for _, id := range []string{"b", "c"} {
		if backend.hasCall(2, id) {
			t.Fatalf("stale generation 1 callback released dependent %s in generation 2", id)
		}
	}
	for _, ev := range run2.Trace() {
		if ev.Kind == TraceApplySucceeded && ev.NodeID == "a" {
			t.Fatal("generation 2 marked a succeeded from a generation 1 callback")
		}
	}
	if got := e.RejectedCallbacks(); got != 1 {
		t.Fatalf("rejected callbacks = %d, want 1", got)
	}

	oldReport := waitReport(t, run1)
	if oldReport.State != RunSuperseded {
		t.Fatalf("generation 1 state = %s, want %s", oldReport.State, RunSuperseded)
	}

	backend.release(currentA, okOutcome("a"))
	releaseB := backend.waitForCall(t, 2, "b")
	releaseC := backend.waitForCall(t, 2, "c")
	backend.release(releaseB, okOutcome("b"))
	backend.release(releaseC, okOutcome("c"))
	releaseD := backend.waitForCall(t, 2, "d")
	backend.release(releaseD, okOutcome("d"))

	rep := waitReport(t, run2)
	if rep.State != RunSucceeded {
		t.Fatalf("generation 2 state = %s, want %s", rep.State, RunSucceeded)
	}
	if oldReport.State != RunSuperseded {
		t.Fatalf("generation 1 terminal state changed to %s", oldReport.State)
	}

	if _, err := e.Start(context.Background(), diamondPlan(1)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("generation 1 restart error = %v, want %v", err, ErrStaleGeneration)
	}
	if _, err := e.Start(context.Background(), diamondPlan(2)); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("generation 2 reuse error = %v, want %v", err, ErrStaleGeneration)
	}
}

func TestLateDuplicateCallbackDoesNotChangeTerminalState(t *testing.T) {
	backend := newHeldBackend()
	e := newTestExecutor(t, backend)
	plan := Plan{
		ID:         "single",
		Generation: 1,
		Nodes:      []Node{{ID: "only", Action: ActionCreate, Reversible: true}},
	}
	run, err := e.Start(context.Background(), plan)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	call := backend.waitForCall(t, 1, "only")
	backend.release(call, okOutcome("only"))
	first := waitReport(t, run)
	traceLen := len(run.Trace())

	call.done(okOutcome("only"))
	call.done(ApplyOutcome{Effected: true, Err: errors.New("late failure")})
	time.Sleep(20 * time.Millisecond)

	second := waitReport(t, run)
	if first.State != second.State || first.State != RunSucceeded {
		t.Fatalf("terminal state changed: %s then %s", first.State, second.State)
	}
	if got := len(run.Trace()); got != traceLen {
		t.Fatalf("trace grew from %d to %d after terminal state", traceLen, got)
	}
}

func TestPlanValidation(t *testing.T) {
	valid := func() Plan {
		return Plan{ID: "p", Generation: 1, Nodes: []Node{{ID: "a", Action: ActionCreate}}}
	}
	tests := []struct {
		name string
		plan Plan
	}{
		{"empty plan ID", func() Plan { p := valid(); p.ID = ""; return p }()},
		{"zero generation", func() Plan { p := valid(); p.Generation = 0; return p }()},
		{"no nodes", Plan{ID: "p", Generation: 1}},
		{"empty node ID", func() Plan { p := valid(); p.Nodes[0].ID = ""; return p }()},
		{"duplicate node ID", Plan{ID: "p", Generation: 1, Nodes: []Node{
			{ID: "a", Action: ActionCreate}, {ID: "a", Action: ActionUpdate},
		}}},
		{"bad action", func() Plan { p := valid(); p.Nodes[0].Action = "replace"; return p }()},
		{"unknown dependency", func() Plan { p := valid(); p.Nodes[0].Deps = []string{"missing"}; return p }()},
		{"self dependency", func() Plan { p := valid(); p.Nodes[0].Deps = []string{"a"}; return p }()},
		{"duplicate dependency", Plan{ID: "p", Generation: 1, Nodes: []Node{
			{ID: "a", Action: ActionCreate},
			{ID: "b", Action: ActionCreate, Deps: []string{"a", "a"}},
		}}},
		{"dependency cycle", Plan{ID: "p", Generation: 1, Nodes: []Node{
			{ID: "a", Action: ActionCreate, Deps: []string{"c"}},
			{ID: "b", Action: ActionCreate, Deps: []string{"a"}},
			{ID: "c", Action: ActionCreate, Deps: []string{"b"}},
		}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newTestExecutor(t, &instantBackend{})
			if _, err := e.Start(context.Background(), tt.plan); !errors.Is(err, ErrInvalidPlan) {
				t.Fatalf("error = %v, want %v", err, ErrInvalidPlan)
			}
		})
	}

	if _, err := NewExecutor(nil); err == nil {
		t.Fatal("NewExecutor(nil) returned no error")
	}
}

func TestCallerCancellationFailsRun(t *testing.T) {
	backend := &cancelAwareBackend{}
	e := newTestExecutor(t, backend)
	ctx, cancel := context.WithCancel(context.Background())
	run, err := e.Start(ctx, diamondPlan(1))
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	cancel()
	rep := waitReport(t, run)
	if rep.State != RunFailed {
		t.Fatalf("state = %s, want %s", rep.State, RunFailed)
	}
	if !errors.Is(rep.Err, context.Canceled) {
		t.Fatalf("run error = %v, want context.Canceled", rep.Err)
	}
	a, ok := rep.Node("a")
	if !ok || a.State != NodeFailed || a.Effected {
		t.Fatalf("node a = %+v, want failed without effect", a)
	}
}

func TestRollbackPanicBecomesCompensationFailure(t *testing.T) {
	e := newTestExecutor(t, &panicRollbackBackend{})
	plan := Plan{
		ID:         "panic-rollback",
		Generation: 1,
		Nodes: []Node{
			{ID: "a", Action: ActionCreate, Reversible: true},
			{ID: "b", Action: ActionCreate, Reversible: true},
		},
	}
	rep, err := e.Execute(context.Background(), plan)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if rep.State != RunFailed {
		t.Fatalf("state = %s, want %s", rep.State, RunFailed)
	}
	b, _ := rep.Node("b")
	if b.State != NodeCompensationFailed || b.RollbackErr == nil {
		t.Fatalf("node b = %+v, want compensation failure", b)
	}
}

type instantBackend struct {
	mu       sync.Mutex
	appliedN int
	rolledN  int
}

func (b *instantBackend) Apply(_ context.Context, req ApplyRequest, done func(ApplyOutcome)) error {
	b.mu.Lock()
	b.appliedN++
	b.mu.Unlock()
	done(okOutcome(req.Node.ID))
	return nil
}

func (b *instantBackend) Rollback(_ context.Context, req RollbackRequest) error {
	b.mu.Lock()
	b.rolledN++
	b.mu.Unlock()
	return nil
}

func (b *instantBackend) applied() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.appliedN
}

func (b *instantBackend) rolledBack() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.rolledN
}

type cancelAwareBackend struct{}

func (b *cancelAwareBackend) Apply(ctx context.Context, req ApplyRequest, done func(ApplyOutcome)) error {
	go func() {
		<-ctx.Done()
		done(ApplyOutcome{Err: ctx.Err()})
	}()
	return nil
}

func (b *cancelAwareBackend) Rollback(context.Context, RollbackRequest) error { return nil }

type panicRollbackBackend struct{}

func (b *panicRollbackBackend) Apply(_ context.Context, req ApplyRequest, done func(ApplyOutcome)) error {
	if req.Node.ID == "b" {
		done(ApplyOutcome{Effected: true, Err: errors.New("b failed after effect")})
		return nil
	}
	done(okOutcome(req.Node.ID))
	return nil
}

func (b *panicRollbackBackend) Rollback(context.Context, RollbackRequest) error {
	panic("rollback exploded")
}
