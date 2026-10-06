package boolexec

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

func TestVersionReplaceMigratesStableIDsAndZerosChanged(t *testing.T) {
	v1 := AndNode("root",
		ConstLeaf("keep", true),
		OrNode("sub", ConstLeaf("a", false), ConstLeaf("b", true)),
	)
	e := mustExec(t, v1)
	if _, err := e.Eval(context.Background(), v1); err != nil {
		t.Fatalf("Eval: %v", err)
	}
	frozen := e.Snapshot()
	if frozen.Version != 0 {
		t.Fatalf("version = %d, want 0", frozen.Version)
	}

	// v2: stable IDs everywhere, but "sub" changes shape (gains a child) and
	// "a" changes label; "keep" and "b" are structurally identical.
	v2 := AndNode("root",
		ConstLeaf("keep", true),
		OrNode("sub",
			LeafNode("a", "renamed", func(context.Context) (bool, error) { return false, nil }),
			ConstLeaf("b", true),
			ConstLeaf("new", false),
		),
	)
	if err := e.Replace(v2); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	if e.Version() != 1 {
		t.Fatalf("version = %d, want 1", e.Version())
	}

	cov := e.Snapshot()
	// "root" and "sub" hashes changed (children changed) -> zeroed.
	if cov.Count("root") != 0 || cov.Count("sub") != 0 {
		t.Fatalf("structurally changed nodes not zeroed: %v", cov.Counts)
	}
	// "a" label changed -> zeroed; "new" is new -> zero.
	if cov.Count("a") != 0 || cov.Count("new") != 0 {
		t.Fatalf("changed/new nodes not zeroed: %v", cov.Counts)
	}
	// "keep" and "b" unchanged -> counts migrate.
	if cov.Count("keep") != 1 || cov.Count("b") != 1 {
		t.Fatalf("stable counts not migrated: %v", cov.Counts)
	}

	// The frozen v0 table is immutable and unaffected by the replacement.
	if frozen.Count("root") != 1 || frozen.Count("sub") != 1 || frozen.Count("a") != 1 {
		t.Fatalf("frozen coverage mutated: %v", frozen.Counts)
	}

	carried, reset := e.Migrated(frozen)
	if len(carried) != 2 || carried["keep"] != 1 || carried["b"] != 1 {
		t.Fatalf("carried = %v, want keep+b", carried)
	}
	if len(reset) != 4 { // root, sub, a, new
		t.Fatalf("reset = %v, want 4 nodes", reset)
	}
}

func TestReplaceWithInvalidTreeKeepsOldVersion(t *testing.T) {
	v1 := ConstLeaf("only", true)
	e := mustExec(t, v1)
	if _, err := e.Eval(context.Background(), v1); err != nil {
		t.Fatalf("Eval: %v", err)
	}
	if err := e.Replace(AndNode("bad")); err == nil {
		t.Fatal("expected validation error")
	}
	if e.Version() != 0 {
		t.Fatalf("version advanced on failed replace")
	}
	if cov := e.Snapshot(); cov.Count("only") != 1 {
		t.Fatalf("counts lost on failed replace: %v", cov.Counts)
	}
}

// TestBarrierShortCircuitPanicAndReplace exercises the race between
// concurrent counting, cancellation, panics, and version replacement behind a
// barrier, verifying that no started count is ever lost.
func TestBarrierShortCircuitPanicAndReplace(t *testing.T) {
	const workers = 16

	release := make(chan struct{})
	var arrived atomic.Int64
	barrierLeaf := LeafNode("barrier", "gate", func(ctx context.Context) (bool, error) {
		arrived.Add(1)
		select {
		case <-release:
			return true, nil
		case <-ctx.Done():
			return false, ctx.Err()
		}
	})
	v1 := OrNode("root",
		ConstLeaf("shortcut", true), // short-circuits; barrier never runs in v1 evals
		barrierLeaf,
	)
	e := mustExec(t, v1)

	// Phase 1: pure short-circuit — barrier leaf must never be touched.
	for i := 0; i < 100; i++ {
		got, err := e.Eval(context.Background(), v1)
		if err != nil || !got {
			t.Fatalf("Eval: %v %v", got, err)
		}
	}
	if cov := e.Snapshot(); cov.Count("barrier") != 0 || arrived.Load() != 0 {
		t.Fatalf("short-circuited leaf evaluated: %v", cov.Counts)
	}

	// Phase 2: v2 drops the shortcut so workers block on the barrier leaf.
	v2 := AndNode("root",
		ConstLeaf("gate", true),
		LeafNode("barrier", "gate", barrierLeaf.Leaf),
		LeafNode("panicker", "boom", func(context.Context) (bool, error) { panic("boom") }),
	)
	if err := e.Replace(v2); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	base := e.Snapshot()

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	var panics, cancels atomic.Int64
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := e.Eval(ctx, v2)
			var pe *PanicError
			switch {
			case err == nil:
			case errors.As(err, &pe):
				panics.Add(1)
			default:
				cancels.Add(1)
			}
		}()
	}

	// Wait until every worker is parked inside the barrier leaf, then fire
	// cancellation and a version replacement concurrently with the release.
	for arrived.Load() < workers {
	}
	v3 := AndNode("root",
		ConstLeaf("gate", true),
		LeafNode("barrier", "gate", barrierLeaf.Leaf),
		ConstLeaf("tail", true),
	)
	var replacer sync.WaitGroup
	replacer.Add(2)
	go func() { defer replacer.Done(); cancel() }()
	go func() { defer replacer.Done(); _ = e.Replace(v3) }()
	close(release)
	wg.Wait()
	replacer.Wait()

	if panics.Load()+cancels.Load() != workers {
		t.Fatalf("workers finished with %d panics + %d cancels = %d, want %d",
			panics.Load(), cancels.Load(), panics.Load()+cancels.Load(), workers)
	}

	// Every worker began evaluating "gate" and "barrier" exactly once before
	// the replacement; both are structurally stable across v2->v3, so none of
	// those started counts may be lost.
	cov := e.Snapshot()
	if got := cov.Count("gate"); got != uint64(workers) {
		t.Fatalf("gate count = %d, want %d", got, workers)
	}
	if got := cov.Count("barrier"); got != uint64(workers) {
		t.Fatalf("barrier count = %d, want %d", got, workers)
	}
	// "root" changed shape between v2 and v3 (panicker -> tail), so its
	// started counts are zeroed by the replacement, not migrated.
	if got := cov.Count("root"); got != 0 {
		t.Fatalf("root count = %d, want 0 (structurally changed node not zeroed)", got)
	}
	// v3 replaced "panicker" with "tail": the new node starts at zero and the
	// old one's counts are gone from the table.
	if _, ok := cov.Counts["panicker"]; ok {
		t.Fatalf("removed node still in table: %v", cov.Counts)
	}
	if cov.Count("tail") != 0 {
		t.Fatalf("new node not zeroed: %v", cov.Counts)
	}
	// Frozen pre-phase-2 snapshot is untouched.
	if base.Count("root") != 0 || base.Version != 1 {
		t.Fatalf("frozen snapshot mutated: %+v", base)
	}
}
