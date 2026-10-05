package pipeline

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// TestSpawnBeforeLastTaskCompletes is the core drain-semantics test: a task
// derives a successor as its very last action, and Wait must not declare
// completion until that successor has also finished. A completion check
// based on a momentarily empty queue (or a zero count sampled too early)
// would return before childDone is set.
func TestSpawnBeforeLastTaskCompletes(t *testing.T) {
	p := New()

	var childDone atomic.Bool
	var childStartedAfterParent atomic.Bool
	var parentFinishing atomic.Bool

	err := p.Submit(func(ctx context.Context, s *Scope) error {
		// Derive the successor right before this (currently last) task ends.
		if err := s.Spawn(func(ctx context.Context, s *Scope) error {
			childStartedAfterParent.Store(parentFinishing.Load())
			time.Sleep(50 * time.Millisecond)
			childDone.Store(true)
			return nil
		}); err != nil {
			return err
		}
		parentFinishing.Store(true)
		return nil
	})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	p.Close()
	if err := p.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}

	if !childDone.Load() {
		t.Fatal("Wait returned before the derived successor finished")
	}
	if !childStartedAfterParent.Load() {
		t.Fatal("successor was not derived while the last task was completing")
	}
	st := p.Stats()
	if st.Submitted != 2 || st.Completed != 2 || st.Failed != 0 {
		t.Fatalf("stats = %+v, want Submitted=2 Completed=2 Failed=0", st)
	}
}

// TestDrainFollowsSuccessors builds a chain in which every task derives the
// next one just before returning; Wait must follow the whole chain.
func TestDrainFollowsSuccessors(t *testing.T) {
	p := New()
	const depth = 200
	var ran atomic.Int64

	var makeTask func(i int) Task
	makeTask = func(i int) Task {
		return func(ctx context.Context, s *Scope) error {
			ran.Add(1)
			if i+1 < depth {
				if err := s.Spawn(makeTask(i + 1)); err != nil {
					return err
				}
			}
			return nil
		}
	}
	if err := p.Submit(makeTask(0)); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	p.Close()
	if err := p.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if got := ran.Load(); got != depth {
		t.Fatalf("ran %d tasks, want %d", got, depth)
	}
}

// TestFailureStopsDerivation verifies that once a task fails, further
// derivation is rejected, the context is cancelled, Wait reports the first
// error, and event counts stay conserved.
func TestFailureStopsDerivation(t *testing.T) {
	p := New()
	boom := errors.New("boom")

	var derivedRan atomic.Bool
	releaseObserver := make(chan struct{})
	spawnErrCh := make(chan error, 1)

	// Observer outlives the failure, sees the cancelled context, and then
	// tries to derive more work, which must be rejected.
	if err := p.Submit(func(ctx context.Context, s *Scope) error {
		<-ctx.Done()
		close(releaseObserver)
		spawnErrCh <- s.Spawn(func(context.Context, *Scope) error {
			derivedRan.Store(true)
			return nil
		})
		return nil
	}); err != nil {
		t.Fatalf("Submit observer: %v", err)
	}
	if err := p.Submit(func(context.Context, *Scope) error {
		return boom
	}); err != nil {
		t.Fatalf("Submit failing task: %v", err)
	}

	p.Close()
	if err := p.Wait(); !errors.Is(err, boom) {
		t.Fatalf("Wait error = %v, want %v", err, boom)
	}

	<-releaseObserver
	if err := <-spawnErrCh; !errors.Is(err, ErrCancelled) {
		t.Fatalf("Spawn after failure = %v, want ErrCancelled", err)
	}
	// Give the rejected task a chance to (incorrectly) run.
	time.Sleep(20 * time.Millisecond)
	if derivedRan.Load() {
		t.Fatal("task derived after a failure must not run")
	}
	if err := p.Submit(func(context.Context, *Scope) error { return nil }); !errors.Is(err, ErrCancelled) {
		t.Fatalf("Submit after failure = %v, want ErrCancelled", err)
	}

	st := p.Stats()
	if st.Submitted != st.Completed+st.Failed {
		t.Fatalf("conservation violated: %+v", st)
	}
	if st.Failed != 1 || st.Submitted != 2 {
		t.Fatalf("stats = %+v, want Submitted=2 Failed=1", st)
	}
}

// TestSubmitAfterClose checks that closing seals only the entry.
func TestSubmitAfterClose(t *testing.T) {
	p := New()
	var derivedRan atomic.Bool

	if err := p.Submit(func(ctx context.Context, s *Scope) error {
		// Derivation after Close is still legal for accepted tasks.
		return s.Spawn(func(context.Context, *Scope) error {
			derivedRan.Store(true)
			return nil
		})
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	p.Close()
	if err := p.Submit(func(context.Context, *Scope) error { return nil }); !errors.Is(err, ErrClosed) {
		t.Fatalf("Submit after Close = %v, want ErrClosed", err)
	}
	if err := p.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if !derivedRan.Load() {
		t.Fatal("successor derived after Close did not run")
	}
}

// TestStatsConservation stresses the counters with many concurrent tasks,
// some of which derive children and some of which fail, and checks that
// every accepted task is accounted for exactly once.
func TestStatsConservation(t *testing.T) {
	p := New()
	const roots = 64
	var finished atomic.Int64

	failErr := errors.New("nope")
	var makeTask func(i int) Task
	makeTask = func(i int) Task {
		return func(ctx context.Context, s *Scope) error {
			defer finished.Add(1)
			if i%7 == 0 {
				return failErr
			}
			if i%3 == 0 {
				// May be rejected if another task already failed; either
				// way the counters must stay conserved.
				_ = s.Spawn(makeTask(i + 1000))
			}
			select {
			case <-ctx.Done():
			case <-time.After(time.Millisecond):
			}
			return nil
		}
	}
	for i := 0; i < roots; i++ {
		err := p.Submit(makeTask(i))
		if errors.Is(err, ErrCancelled) {
			// A task may fail before all entries are in; rejection is
			// part of the contract and keeps the counters conserved.
			break
		}
		if err != nil {
			t.Fatalf("Submit %d: %v", i, err)
		}
	}
	if err := p.Shutdown(); !errors.Is(err, failErr) {
		t.Fatalf("Shutdown error = %v, want %v", err, failErr)
	}

	st := p.Stats()
	if st.Submitted != st.Completed+st.Failed {
		t.Fatalf("conservation violated: %+v", st)
	}
	if int64(st.Submitted) != finished.Load() {
		t.Fatalf("Submitted=%d but %d tasks actually finished", st.Submitted, finished.Load())
	}
	if st.Failed == 0 {
		t.Fatal("expected at least one recorded failure")
	}
}

// TestWaitBlocksUntilDrain makes sure Wait cannot return while any accepted
// task is still running, even when the entry was closed long before.
func TestWaitBlocksUntilDrain(t *testing.T) {
	p := New()
	var running, maxSeen atomic.Int64
	for i := 0; i < 32; i++ {
		i := i
		if err := p.Submit(func(ctx context.Context, s *Scope) error {
			cur := running.Add(1)
			for {
				old := maxSeen.Load()
				if cur <= old || maxSeen.CompareAndSwap(old, cur) {
					break
				}
			}
			time.Sleep(time.Duration(i%5) * time.Millisecond)
			if i%2 == 0 {
				if err := s.Spawn(func(context.Context, *Scope) error {
					time.Sleep(10 * time.Millisecond)
					return nil
				}); err != nil {
					return err
				}
			}
			running.Add(-1)
			return nil
		}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}
	p.Close()
	if err := p.Wait(); err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if got := running.Load(); got != 0 {
		t.Fatalf("Wait returned with %d tasks still running", got)
	}
	st := p.Stats()
	if st.Submitted != 48 || st.Completed != 48 {
		t.Fatalf("stats = %+v, want Submitted=48 Completed=48", st)
	}
}
