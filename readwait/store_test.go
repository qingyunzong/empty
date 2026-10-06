package readwait

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// TestReadBlocksUntilTargetApplied verifies a read registered at a target
// index only returns once the replica has applied that index, and then sees
// the value written by the apply that crossed the target.
func TestReadBlocksUntilTargetApplied(t *testing.T) {
	s := NewStore()
	s.Apply(1, Entry{Key: "a", Value: "old"})

	type result struct {
		v   string
		err error
	}
	done := make(chan result, 1)
	go func() {
		v, err := s.Read(context.Background(), 5, "a")
		done <- result{v, err}
	}()

	// The read must still be blocked: indexes 2..4 do not reach target 5.
	for i := uint64(2); i <= 4; i++ {
		s.Apply(i, Entry{Key: "a", Value: fmt.Sprintf("v%d", i)})
		select {
		case <-done:
			t.Fatalf("read returned before target applied (index %d)", i)
		case <-time.After(10 * time.Millisecond):
		}
	}

	s.Apply(5, Entry{Key: "a", Value: "v5"})
	select {
	case r := <-done:
		if r.err != nil {
			t.Fatalf("read failed: %v", r.err)
		}
		if r.v != "v5" {
			t.Fatalf("got %q, want %q", r.v, "v5")
		}
	case <-time.After(time.Second):
		t.Fatal("read did not return after target applied")
	}
}

// TestReadTimeoutReportsNotReached verifies a timeout returns ErrNotReached
// and no (stale) value, even though the key exists at an older index.
func TestReadTimeoutReportsNotReached(t *testing.T) {
	s := NewStore()
	s.Apply(1, Entry{Key: "a", Value: "stale"})

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	v, err := s.Read(ctx, 100, "a")
	if !errors.Is(err, ErrNotReached) {
		t.Fatalf("got err %v, want ErrNotReached", err)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got err %v, want it to wrap context.DeadlineExceeded", err)
	}
	if v != "" {
		t.Fatalf("got stale value %q on timeout, want none", v)
	}
	if n := s.Waiters(); n != 0 {
		t.Fatalf("waiter leaked after timeout: %d pending", n)
	}
}

// TestCancelRemovesWaiter verifies cancelling the read context removes the
// registered waiter immediately.
func TestCancelRemovesWaiter(t *testing.T) {
	s := NewStore()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := s.Read(ctx, 10, "k")
		done <- err
	}()

	waitFor(t, time.Second, func() bool { return s.Waiters() == 1 })
	cancel()
	if err := <-done; !errors.Is(err, ErrNotReached) || !errors.Is(err, context.Canceled) {
		t.Fatalf("got err %v, want ErrNotReached wrapping context.Canceled", err)
	}
	if n := s.Waiters(); n != 0 {
		t.Fatalf("waiter not removed after cancel: %d pending", n)
	}
}

// TestBatchWakeup verifies a single apply wakes every waiter whose target is
// satisfied, while higher-target waiters keep waiting.
func TestBatchWakeup(t *testing.T) {
	s := NewStore()

	const readers = 8
	var wg sync.WaitGroup
	errs := make([]error, readers)
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			target := uint64(3 + i%3) // targets 3, 4, 5
			_, errs[i] = s.Read(context.Background(), target, "k")
		}(i)
	}
	waitFor(t, time.Second, func() bool { return s.Waiters() == readers })

	// One apply to index 4 must wake the readers targeting 3 and 4 in a
	// single batch, leaving only the target-5 readers pending.
	s.Apply(4, Entry{Key: "k", Value: "v4"})
	waitFor(t, time.Second, func() bool { return s.Waiters() == readers/3 })

	s.Apply(5, Entry{Key: "k", Value: "v5"})
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("reader %d failed: %v", i, err)
		}
	}
	if got := s.MustRead(context.Background(), 5, "k"); got != "v5" {
		t.Fatalf("got %q, want %q", got, "v5")
	}
}

// TestSameTickApplyWinsOverDeadline verifies that when the apply and the
// context deadline happen at the same tick, the read is served rather than
// failing: registration happens first, so an already-reached target always
// succeeds even on an expired context.
func TestSameTickApplyWinsOverDeadline(t *testing.T) {
	s := NewStore()
	s.Apply(7, Entry{Key: "k", Value: "v7"})

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // deadline already passed at call time

	v, err := s.Read(ctx, 7, "k")
	if err != nil {
		t.Fatalf("same-tick read failed: %v", err)
	}
	if v != "v7" {
		t.Fatalf("got %q, want %q", v, "v7")
	}
}

// TestSameTickMissReportsNotReached verifies the opposite tie: the context
// expired and the target was never applied, so the read fails with
// ErrNotReached instead of serving a stale value.
func TestSameTickMissReportsNotReached(t *testing.T) {
	s := NewStore()
	s.Apply(6, Entry{Key: "k", Value: "stale"})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := s.Read(ctx, 7, "k"); !errors.Is(err, ErrNotReached) {
		t.Fatalf("got err %v, want ErrNotReached", err)
	}
}

// TestSnapshotInstallNeverRegressesApplied verifies installing a snapshot
// older than the applied index does not move the barrier backwards, while a
// newer snapshot advances it and wakes waiters.
func TestSnapshotInstallNeverRegressesApplied(t *testing.T) {
	s := NewStore()
	s.Apply(10, Entry{Key: "k", Value: "v10"})

	s.InstallSnapshot(5, map[string]string{"k": "snap5"})
	if got := s.Applied(); got != 10 {
		t.Fatalf("applied regressed to %d, want 10", got)
	}

	// A read at index 8 must still succeed immediately: the barrier did not
	// regress to the snapshot's older index.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := s.Read(ctx, 8, "k"); err != nil {
		t.Fatalf("read at pre-snapshot index failed after old snapshot install: %v", err)
	}

	// A newer snapshot advances the barrier and wakes pending readers.
	done := make(chan error, 1)
	go func() {
		_, err := s.Read(context.Background(), 20, "k")
		done <- err
	}()
	waitFor(t, time.Second, func() bool { return s.Waiters() == 1 })
	s.InstallSnapshot(20, map[string]string{"k": "snap20"})
	if err := <-done; err != nil {
		t.Fatalf("reader not woken by snapshot install: %v", err)
	}
	if got := s.Applied(); got != 20 {
		t.Fatalf("applied = %d, want 20", got)
	}
	if got := s.MustRead(context.Background(), 20, "k"); got != "snap20" {
		t.Fatalf("got %q, want snapshot value %q", got, "snap20")
	}
}

// TestApplyNeverRegressesApplied verifies applying an old index is a no-op
// for the barrier.
func TestApplyNeverRegressesApplied(t *testing.T) {
	s := NewStore()
	s.Apply(10)
	s.Apply(4)
	s.Apply(10)
	if got := s.Applied(); got != 10 {
		t.Fatalf("applied = %d, want 10", got)
	}
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition not met before deadline")
}
