package readwait

import (
	"context"
	"errors"
	"testing"
	"time"
)

func waitForWaiters(t *testing.T, tr *Tracker, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if tr.WaiterCount() == n {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("waiter count = %d, want %d", tr.WaiterCount(), n)
}

// Same-moment application: applied reaching exactly the target wakes the
// waiter.
func TestWaitAppliedSameMoment(t *testing.T) {
	tr := NewTracker(nil)
	done := make(chan error, 1)
	go func() {
		done <- tr.WaitApplied(context.Background(), 5, time.Minute)
	}()
	waitForWaiters(t, tr, 1)

	if woken := tr.NotifyApplied(5); woken != 1 {
		t.Fatalf("woken = %d, want 1", woken)
	}
	if err := <-done; err != nil {
		t.Fatalf("WaitApplied returned %v, want nil", err)
	}
	if got := tr.WaiterCount(); got != 0 {
		t.Fatalf("waiter not removed after wake: %d", got)
	}
}

// Timeout reports *NotAppliedError — an explicit miss, never a stale value.
func TestWaitAppliedTimeout(t *testing.T) {
	clk := NewManualClock(time.Unix(0, 0))
	tr := NewTracker(clk)
	tr.NotifyApplied(3)

	done := make(chan error, 1)
	go func() {
		done <- tr.WaitApplied(context.Background(), 5, 10*time.Second)
	}()
	waitForWaiters(t, tr, 1)

	clk.Advance(10 * time.Second)

	err := <-done
	var nae *NotAppliedError
	if !errors.As(err, &nae) {
		t.Fatalf("error = %v, want *NotAppliedError", err)
	}
	if nae.Target != 5 || nae.Applied != 3 {
		t.Fatalf("NotAppliedError = %+v, want Target 5 Applied 3", nae)
	}
	if got := tr.WaiterCount(); got != 0 {
		t.Fatalf("waiter not removed after timeout: %d", got)
	}
}

// Batch wake-up: one advance wakes every satisfied waiter at once.
func TestWaitAppliedBatchWake(t *testing.T) {
	tr := NewTracker(nil)
	targets := []uint64{3, 5, 7}
	done := make(chan error, len(targets))
	for _, target := range targets {
		go func(target uint64) {
			done <- tr.WaitApplied(context.Background(), target, time.Minute)
		}(target)
	}
	waitForWaiters(t, tr, len(targets))

	if woken := tr.NotifyApplied(7); woken != len(targets) {
		t.Fatalf("woken = %d, want %d", woken, len(targets))
	}
	for range targets {
		if err := <-done; err != nil {
			t.Fatalf("WaitApplied returned %v, want nil", err)
		}
	}

	// A waiter beyond the applied index stays registered.
	pending := make(chan error, 1)
	go func() {
		pending <- tr.WaitApplied(context.Background(), 9, time.Minute)
	}()
	waitForWaiters(t, tr, 1)
	if woken := tr.NotifyApplied(8); woken != 0 {
		t.Fatalf("woken = %d, want 0", woken)
	}
	select {
	case err := <-pending:
		t.Fatalf("waiter at 9 woke at applied 8: %v", err)
	default:
	}
	if woken := tr.NotifyApplied(9); woken != 1 {
		t.Fatalf("woken = %d, want 1", woken)
	}
	if err := <-pending; err != nil {
		t.Fatalf("WaitApplied returned %v, want nil", err)
	}
}

// Cancellation removes the waiter.
func TestWaitAppliedCancelRemovesWaiter(t *testing.T) {
	tr := NewTracker(nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- tr.WaitApplied(ctx, 5, time.Minute)
	}()
	waitForWaiters(t, tr, 1)

	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if got := tr.WaiterCount(); got != 0 {
		t.Fatalf("waiter not removed after cancel: %d", got)
	}
}

func TestWaitAppliedAlreadyApplied(t *testing.T) {
	tr := NewTracker(nil)
	tr.NotifyApplied(5)
	if err := tr.WaitApplied(context.Background(), 5, time.Nanosecond); err != nil {
		t.Fatalf("WaitApplied = %v, want nil for already-applied target", err)
	}
	if got := tr.WaiterCount(); got != 0 {
		t.Fatalf("waiter registered for already-applied target: %d", got)
	}
}

func TestNotifyAppliedMonotonic(t *testing.T) {
	tr := NewTracker(nil)
	tr.NotifyApplied(8)
	tr.NotifyApplied(3)
	if got := tr.Applied(); got != 8 {
		t.Fatalf("applied = %d, want 8 (no regression)", got)
	}
}

// Snapshot installation never regresses the applied index.
func TestInstallSnapshotNeverRegresses(t *testing.T) {
	tr := NewTracker(nil)
	tr.NotifyApplied(10)

	if tr.InstallSnapshot(5) {
		t.Fatal("stale snapshot installed")
	}
	if got := tr.Applied(); got != 10 {
		t.Fatalf("applied = %d, want 10 after stale snapshot", got)
	}
	if tr.InstallSnapshot(10) {
		t.Fatal("snapshot at current applied index installed")
	}

	done := make(chan error, 1)
	go func() {
		done <- tr.WaitApplied(context.Background(), 12, time.Minute)
	}()
	waitForWaiters(t, tr, 1)

	if !tr.InstallSnapshot(12) {
		t.Fatal("newer snapshot rejected")
	}
	if got := tr.Applied(); got != 12 {
		t.Fatalf("applied = %d, want 12", got)
	}
	if err := <-done; err != nil {
		t.Fatalf("waiter not woken by snapshot: %v", err)
	}
}
