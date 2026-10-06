package boolexec

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

func mustExec(t *testing.T, root *Node) *Executor {
	t.Helper()
	e, err := NewExecutor(root)
	if err != nil {
		t.Fatalf("NewExecutor: %v", err)
	}
	return e
}

func TestAndShortCircuitSkipsRightSide(t *testing.T) {
	var rightReads atomic.Int64
	root := AndNode("and",
		ConstLeaf("l-false", false),
		LeafNode("l-right", "probe", func(context.Context) (bool, error) {
			rightReads.Add(1)
			return true, nil
		}),
		ConstLeaf("l-never", true),
	)
	e := mustExec(t, root)
	got, err := e.Eval(context.Background(), root)
	if err != nil {
		t.Fatalf("Eval: %v", err)
	}
	if got {
		t.Fatal("expected false")
	}
	if rightReads.Load() != 0 {
		t.Fatalf("right side was evaluated %d times; short-circuit violated", rightReads.Load())
	}
	cov := e.Snapshot()
	if cov.Count("and") != 1 || cov.Count("l-false") != 1 {
		t.Fatalf("started nodes not counted: %v", cov.Counts)
	}
	if cov.Count("l-right") != 0 || cov.Count("l-never") != 0 {
		t.Fatalf("unvisited nodes were counted: %v", cov.Counts)
	}
}

func TestOrShortCircuitSkipsRightSide(t *testing.T) {
	var rightReads atomic.Int64
	root := OrNode("or",
		ConstLeaf("l-true", true),
		LeafNode("l-right", "probe", func(context.Context) (bool, error) {
			rightReads.Add(1)
			return false, nil
		}),
	)
	e := mustExec(t, root)
	got, err := e.Eval(context.Background(), root)
	if err != nil || !got {
		t.Fatalf("got %v, %v; want true, nil", got, err)
	}
	if rightReads.Load() != 0 {
		t.Fatalf("right side evaluated despite short-circuit")
	}
	if cov := e.Snapshot(); cov.Count("l-right") != 0 {
		t.Fatalf("unvisited node counted: %v", cov.Counts)
	}
}

func TestOrFallsThroughOnFalse(t *testing.T) {
	var reads atomic.Int64
	root := OrNode("or",
		ConstLeaf("a", false),
		LeafNode("b", "probe", func(context.Context) (bool, error) {
			reads.Add(1)
			return true, nil
		}),
		ConstLeaf("c", true),
	)
	e := mustExec(t, root)
	got, err := e.Eval(context.Background(), root)
	if err != nil || !got {
		t.Fatalf("got %v, %v; want true, nil", got, err)
	}
	if reads.Load() != 1 {
		t.Fatalf("leaf b read %d times, want 1", reads.Load())
	}
	cov := e.Snapshot()
	if cov.Count("a") != 1 || cov.Count("b") != 1 || cov.Count("c") != 0 {
		t.Fatalf("bad counts: %v", cov.Counts)
	}
}

func TestNotEvaluatesChild(t *testing.T) {
	root := NotNode("not", ConstLeaf("a", false))
	e := mustExec(t, root)
	got, err := e.Eval(context.Background(), root)
	if err != nil || !got {
		t.Fatalf("got %v, %v; want true, nil", got, err)
	}
	if cov := e.Snapshot(); cov.Count("not") != 1 || cov.Count("a") != 1 {
		t.Fatalf("bad counts: %v", cov.Counts)
	}
}

func TestPanicCountsStartedNodes(t *testing.T) {
	var afterReads atomic.Int64
	root := AndNode("and",
		ConstLeaf("before", true),
		LeafNode("boom", "panics", func(context.Context) (bool, error) {
			panic("kaboom")
		}),
		LeafNode("after", "probe", func(context.Context) (bool, error) {
			afterReads.Add(1)
			return true, nil
		}),
	)
	e := mustExec(t, root)
	_, err := e.Eval(context.Background(), root)
	var pe *PanicError
	if !errors.As(err, &pe) {
		t.Fatalf("expected *PanicError, got %v", err)
	}
	if pe.NodeID != "boom" {
		t.Fatalf("panic attributed to %q, want boom", pe.NodeID)
	}
	cov := e.Snapshot()
	// Nodes that began evaluation are counted, including the panicking one.
	if cov.Count("and") != 1 || cov.Count("before") != 1 || cov.Count("boom") != 1 {
		t.Fatalf("started nodes lost: %v", cov.Counts)
	}
	// The node after the panic never started.
	if cov.Count("after") != 0 || afterReads.Load() != 0 {
		t.Fatalf("node after panic was evaluated/counted: %v", cov.Counts)
	}
}

func TestLeafErrorCountsStartedAndStops(t *testing.T) {
	sentinel := errors.New("nope")
	root := OrNode("or",
		ConstLeaf("a", false),
		LeafNode("bad", "errs", func(context.Context) (bool, error) {
			return false, sentinel
		}),
		ConstLeaf("c", true),
	)
	e := mustExec(t, root)
	_, err := e.Eval(context.Background(), root)
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected sentinel error, got %v", err)
	}
	cov := e.Snapshot()
	if cov.Count("or") != 1 || cov.Count("a") != 1 || cov.Count("bad") != 1 || cov.Count("c") != 0 {
		t.Fatalf("bad counts: %v", cov.Counts)
	}
}

func TestCancellationKeepsStartedCounts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var laterReads atomic.Int64
	root := AndNode("and",
		LeafNode("canceller", "cancel", func(context.Context) (bool, error) {
			cancel()
			return true, nil
		}),
		LeafNode("later", "probe", func(context.Context) (bool, error) {
			laterReads.Add(1)
			return true, nil
		}),
	)
	e := mustExec(t, root)
	_, err := e.Eval(ctx, root)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	cov := e.Snapshot()
	if cov.Count("and") != 1 || cov.Count("canceller") != 1 {
		t.Fatalf("started counts lost on cancellation: %v", cov.Counts)
	}
	if cov.Count("later") != 0 || laterReads.Load() != 0 {
		t.Fatalf("cancelled branch evaluated: %v", cov.Counts)
	}
}

func TestPreCancelledContextCountsNothing(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	root := AndNode("and", ConstLeaf("a", true))
	e := mustExec(t, root)
	if _, err := e.Eval(ctx, root); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	if cov := e.Snapshot(); cov.Total() != 0 {
		t.Fatalf("counts recorded for never-started eval: %v", cov.Counts)
	}
}

func TestValidateRejectsBadTrees(t *testing.T) {
	bad := []*Node{
		AndNode("x"),
		{ID: "x", Kind: Not, Children: []*Node{ConstLeaf("a", true), ConstLeaf("b", true)}},
		{ID: "x", Kind: Leaf},
		AndNode("x", ConstLeaf("dup", true), ConstLeaf("dup", false)),
	}
	for i, n := range bad {
		if _, err := NewExecutor(n); err == nil {
			t.Fatalf("case %d: expected validation error", i)
		}
	}
}
