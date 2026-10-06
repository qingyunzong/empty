package readwait

import (
	"context"
	"errors"
	"testing"
	"time"
)

// A read registers the commit index observed at read time and returns only
// after the replica has applied up to it.
func TestReadWaitsForApply(t *testing.T) {
	r := NewReplica(nil)
	r.Commit("k", "v1")

	type result struct {
		value string
		err   error
	}
	done := make(chan result, 1)
	go func() {
		value, err := r.Read(context.Background(), "k", time.Minute)
		done <- result{value, err}
	}()
	waitForWaiters(t, r.Tracker(), 1)

	// Committed but not applied: the read must still be blocked.
	select {
	case res := <-done:
		t.Fatalf("read returned before apply: %+v", res)
	default:
	}

	r.ApplyTo(1)
	res := <-done
	if res.err != nil || res.value != "v1" {
		t.Fatalf("read = %q, %v; want %q, nil", res.value, res.err, "v1")
	}
}

// Timeout reports an explicit miss instead of the old value.
func TestReadTimeoutNoStaleValue(t *testing.T) {
	clk := NewManualClock(time.Unix(0, 0))
	r := NewReplica(clk)
	r.Commit("k", "old")
	r.ApplyTo(1)

	r.Commit("k", "new") // committed at 2, not yet applied

	type result struct {
		value string
		err   error
	}
	done := make(chan result, 1)
	go func() {
		value, err := r.Read(context.Background(), "k", 5*time.Second)
		done <- result{value, err}
	}()
	waitForWaiters(t, r.Tracker(), 1)

	clk.Advance(5 * time.Second)

	res := <-done
	var nae *NotAppliedError
	if !errors.As(res.err, &nae) {
		t.Fatalf("error = %v, want *NotAppliedError", res.err)
	}
	if res.value != "" {
		t.Fatalf("stale value %q returned on timeout", res.value)
	}
	if nae.Target != 2 || nae.Applied != 1 {
		t.Fatalf("NotAppliedError = %+v, want Target 2 Applied 1", nae)
	}
}

func TestReadCancelRemovesWaiter(t *testing.T) {
	r := NewReplica(nil)
	r.Commit("k", "v")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := r.Read(ctx, "k", time.Minute)
		done <- err
	}()
	waitForWaiters(t, r.Tracker(), 1)

	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
	if got := r.Tracker().WaiterCount(); got != 0 {
		t.Fatalf("waiters = %d, want 0 after cancel", got)
	}
}

// Batch wake-up: one ApplyTo wakes all pending reads.
func TestReadBatchWake(t *testing.T) {
	r := NewReplica(nil)
	r.Commit("k", "v")

	const readers = 4
	done := make(chan string, readers)
	for i := 0; i < readers; i++ {
		go func() {
			value, err := r.Read(context.Background(), "k", time.Minute)
			if err != nil {
				done <- err.Error()
				return
			}
			done <- value
		}()
	}
	waitForWaiters(t, r.Tracker(), readers)

	r.ApplyTo(1)
	for i := 0; i < readers; i++ {
		if value := <-done; value != "v" {
			t.Fatalf("read = %q, want %q", value, "v")
		}
	}
}

// Snapshot installation never regresses the applied index.
func TestReplicaInstallSnapshotNoRegress(t *testing.T) {
	r := NewReplica(nil)
	r.Commit("a", "1")
	r.Commit("b", "2")
	r.ApplyTo(2)

	if r.InstallSnapshot(1, map[string]string{"a": "stale"}) {
		t.Fatal("stale snapshot installed")
	}
	value, err := r.Read(context.Background(), "b", time.Second)
	if err != nil || value != "2" {
		t.Fatalf("read after stale snapshot = %q, %v; want %q, nil", value, err, "2")
	}

	if !r.InstallSnapshot(5, map[string]string{"a": "snap"}) {
		t.Fatal("newer snapshot rejected")
	}
	if got := r.Tracker().Applied(); got != 5 {
		t.Fatalf("applied = %d, want 5", got)
	}
	value, err = r.Read(context.Background(), "a", time.Second)
	if err != nil || value != "snap" {
		t.Fatalf("read after snapshot = %q, %v; want %q, nil", value, err, "snap")
	}
}
