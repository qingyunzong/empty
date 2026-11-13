package dataeng

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func newTestCoordinator(t *testing.T, shards ...Shard) (*Coordinator, *fakeClock, *MemoryStore) {
	t.Helper()
	clock := newFakeClock()
	store := NewMemoryStore()
	coordinator := NewCoordinator(store, WithClock(clock), WithLeaseTTL(10*time.Second))
	if err := coordinator.Observe(shards...); err != nil {
		t.Fatalf("Observe: %v", err)
	}
	return coordinator, clock, store
}

func requireReady(t *testing.T, coordinator *Coordinator, want ...ShardID) {
	t.Helper()
	ready, err := coordinator.ReadyShards(context.Background())
	if err != nil {
		t.Fatalf("ReadyShards: %v", err)
	}
	if len(ready) != len(want) {
		t.Fatalf("ready shards = %v, want %v", ready, want)
	}
	for i := range want {
		if ready[i] != want[i] {
			t.Fatalf("ready shards = %v, want %v", ready, want)
		}
	}
}

func TestChildWaitsForParentAndAdjacentParent(t *testing.T) {
	ctx := context.Background()
	coordinator, _, _ := newTestCoordinator(t,
		Shard{
			ShardID:              "parent-a",
			EndingSequenceNumber: "100",
		},
		Shard{
			ShardID:              "parent-b",
			EndingSequenceNumber: "200",
		},
		Shard{
			ShardID:               "child",
			ParentShardID:         "parent-a",
			AdjacentParentShardID: "parent-b",
			EndingSequenceNumber:  "300",
		},
	)

	requireReady(t, coordinator, "parent-a", "parent-b")

	if _, err := coordinator.Acquire(ctx, "child", "worker-1"); err == nil {
		t.Fatal("child acquired before parents completed")
	} else {
		var pending *PendingParentsError
		if !errors.As(err, &pending) {
			t.Fatalf("Acquire child error = %v, want PendingParentsError", err)
		}
		if len(pending.Parents) != 2 {
			t.Fatalf("pending parents = %v, want both parents", pending.Parents)
		}
		if !errors.Is(err, ErrShardNotReady) || !errors.Is(err, ErrParentsNotComplete) {
			t.Fatalf("error should match not-ready sentinels: %v", err)
		}
	}

	leaseA, err := coordinator.Acquire(ctx, "parent-a", "worker-a")
	if err != nil {
		t.Fatalf("Acquire parent-a: %v", err)
	}
	if _, err := coordinator.Complete(ctx, leaseA, "100", "100"); err != nil {
		t.Fatalf("Complete parent-a: %v", err)
	}

	// The adjacent parent is still running, so the child remains closed.
	readiness, err := coordinator.Readiness(ctx, "child")
	if err != nil {
		t.Fatalf("Readiness child: %v", err)
	}
	if readiness.Ready {
		t.Fatal("child became ready with an incomplete adjacent parent")
	}
	if len(readiness.PendingParents) != 1 || readiness.PendingParents[0] != "parent-b" {
		t.Fatalf("pending parents = %v, want [parent-b]", readiness.PendingParents)
	}

	leaseB, err := coordinator.Acquire(ctx, "parent-b", "worker-b")
	if err != nil {
		t.Fatalf("Acquire parent-b: %v", err)
	}
	if _, err := coordinator.Complete(ctx, leaseB, "200", "200"); err != nil {
		t.Fatalf("Complete parent-b: %v", err)
	}

	requireReady(t, coordinator, "child")
	if _, err := coordinator.Acquire(ctx, "child", "worker-c"); err != nil {
		t.Fatalf("Acquire child after parents completed: %v", err)
	}
}

func TestMissingParentsAreReportedAndResolved(t *testing.T) {
	ctx := context.Background()
	coordinator, _, _ := newTestCoordinator(t,
		Shard{
			ShardID:               "child",
			ParentShardID:         "missing-a",
			AdjacentParentShardID: "missing-b",
			EndingSequenceNumber:  "50",
		},
	)

	report, err := coordinator.Report(ctx)
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if len(report.MissingParents) != 2 {
		t.Fatalf("report missing parents = %v, want two", report.MissingParents)
	}
	if got := report.ReadyShardIDs(); len(got) != 0 {
		t.Fatalf("missing-parent child reported ready: %v", got)
	}

	readiness, err := coordinator.Readiness(ctx, "child")
	if err != nil {
		t.Fatalf("Readiness: %v", err)
	}
	if readiness.Ready || len(readiness.MissingParents) != 2 {
		t.Fatalf("readiness = %+v, want conservative wait with two missing parents", readiness)
	}

	_, err = coordinator.Acquire(ctx, "child", "worker")
	var missing *MissingParentsError
	if !errors.As(err, &missing) {
		t.Fatalf("Acquire error = %v, want MissingParentsError", err)
	}
	if !errors.Is(err, ErrMissingParent) || !errors.Is(err, ErrShardNotReady) {
		t.Fatalf("missing-parent error should match sentinels: %v", err)
	}

	// A parent appearing in a later DescribeStream page must be completed
	// before the child can open rather than being assumed finished.
	if err := coordinator.Observe(Shard{ShardID: "missing-a", EndingSequenceNumber: "10"}); err != nil {
		t.Fatalf("Observe late parent: %v", err)
	}
	if got, err := coordinator.ReadyShards(ctx); err != nil {
		t.Fatalf("ReadyShards: %v", err)
	} else if len(got) != 1 || got[0] != "missing-a" {
		t.Fatalf("ready shards = %v, want [missing-a]", got)
	}

	leaseA, err := coordinator.Acquire(ctx, "missing-a", "worker-a")
	if err != nil {
		t.Fatalf("Acquire late parent: %v", err)
	}
	if _, err := coordinator.Complete(ctx, leaseA, "10", "10"); err != nil {
		t.Fatalf("Complete late parent: %v", err)
	}

	readiness, err = coordinator.Readiness(ctx, "child")
	if err != nil {
		t.Fatalf("Readiness after first parent: %v", err)
	}
	if readiness.Ready || len(readiness.MissingParents) != 1 || readiness.MissingParents[0] != "missing-b" {
		t.Fatalf("remaining missing parent not reported: %+v", readiness)
	}
	if err := coordinator.Observe(Shard{ShardID: "missing-b", EndingSequenceNumber: "20"}); err != nil {
		t.Fatalf("Observe second late parent: %v", err)
	}
	leaseB, err := coordinator.Acquire(ctx, "missing-b", "worker-b")
	if err != nil {
		t.Fatalf("Acquire second late parent: %v", err)
	}
	if _, err := coordinator.Complete(ctx, leaseB, "20", "20"); err != nil {
		t.Fatalf("Complete second late parent: %v", err)
	}
	readiness, err = coordinator.Readiness(ctx, "child")
	if err != nil {
		t.Fatalf("Readiness after both parents: %v", err)
	}
	if !readiness.Ready {
		t.Fatalf("child did not open after both parents completed: %+v", readiness)
	}
}

func TestCompletionRequiresWatermarkAndOutputAckAtomically(t *testing.T) {
	ctx := context.Background()
	coordinator, _, store := newTestCoordinator(t,
		Shard{ShardID: "shard", EndingSequenceNumber: "100"},
		Shard{
			ShardID:              "child",
			ParentShardID:        "shard",
			EndingSequenceNumber: "200",
		},
	)

	lease, err := coordinator.Acquire(ctx, "shard", "worker")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	record, err := coordinator.Commit(ctx, lease, Progress{
		Watermark: "100",
		OutputAck: "90",
	})
	if err != nil {
		t.Fatalf("Commit read-ahead: %v", err)
	}
	if record.Watermark != "100" || record.OutputAck != "90" {
		t.Fatalf("record positions = %q/%q, want 100/90", record.Watermark, record.OutputAck)
	}
	if record.Completed {
		t.Fatal("closed shard completed before output acknowledgement caught up")
	}
	childStatus, err := coordinator.Readiness(ctx, "child")
	if err != nil {
		t.Fatalf("Readiness child: %v", err)
	}
	if childStatus.Ready {
		t.Fatal("child opened before output acknowledgement")
	}

	record, err = coordinator.Commit(ctx, lease, Progress{
		Watermark: "100",
		OutputAck: "100",
	})
	if err != nil {
		t.Fatalf("Commit final positions: %v", err)
	}
	if !record.Completed {
		t.Fatal("closed, fully acknowledged shard did not complete")
	}
	if record.Watermark != "100" || record.OutputAck != "100" {
		t.Fatalf("final record = %+v, want both positions at 100", record)
	}
	stored := store.Snapshot()["shard"]
	if record.Version != stored.Version {
		t.Fatalf("returned version = %d, stored = %d", record.Version, stored.Version)
	}
	if !stored.Completed || stored.Watermark != "100" || stored.OutputAck != "100" {
		t.Fatalf("stored final state = %+v", stored)
	}
	if stored.Lease.Owner != "" {
		t.Fatalf("completed shard retained a lease holder: %+v", stored.Lease)
	}

	requireReady(t, coordinator, "child")
}

func TestRejectedFinalCommitDoesNotAdvanceProgress(t *testing.T) {
	ctx := context.Background()
	coordinator, _, _ := newTestCoordinator(t,
		Shard{ShardID: "shard", EndingSequenceNumber: "100"},
	)
	lease, err := coordinator.Acquire(ctx, "shard", "worker")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}

	_, err = coordinator.Complete(ctx, lease, "100", "80")
	if !errors.Is(err, ErrIncompleteClose) {
		t.Fatalf("Complete error = %v, want ErrIncompleteClose", err)
	}
	state, err := coordinator.State(ctx, "shard")
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Watermark != "" || state.OutputAck != "" || state.Completed {
		t.Fatalf("rejected final commit changed state: %+v", state)
	}

	_, err = coordinator.Commit(ctx, lease, Progress{Watermark: "20", OutputAck: "30"})
	if !errors.Is(err, ErrAckAheadOfWatermark) {
		t.Fatalf("ack-ahead error = %v, want ErrAckAheadOfWatermark", err)
	}
}

func TestOpenShardCannotComplete(t *testing.T) {
	ctx := context.Background()
	coordinator, _, _ := newTestCoordinator(t,
		Shard{ShardID: "open"},
	)
	lease, err := coordinator.Acquire(ctx, "open", "worker")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	_, err = coordinator.Complete(ctx, lease, "100", "100")
	if !errors.Is(err, ErrShardNotClosed) {
		t.Fatalf("Complete error = %v, want ErrShardNotClosed", err)
	}
}

func TestOpaqueSequenceCanAdvanceConservatively(t *testing.T) {
	ctx := context.Background()
	coordinator, _, _ := newTestCoordinator(t,
		Shard{ShardID: "shard", EndingSequenceNumber: "seq-3"},
	)
	lease, err := coordinator.Acquire(ctx, "shard", "worker")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	record, err := coordinator.Commit(ctx, lease, Progress{
		Watermark: "seq-1",
		OutputAck: "seq-1",
	})
	if err != nil {
		t.Fatalf("partial opaque commit: %v", err)
	}
	if record.Completed {
		t.Fatal("opaque midpoint completed the shard")
	}
	record, err = coordinator.Complete(ctx, lease, "seq-3", "seq-3")
	if err != nil {
		t.Fatalf("final opaque commit: %v", err)
	}
	if !record.Completed {
		t.Fatal("exact ending sequence did not complete the shard")
	}
}

func TestPreemptionInvalidatesOldLeaseGeneration(t *testing.T) {
	ctx := context.Background()
	coordinator, clock, _ := newTestCoordinator(t,
		Shard{ShardID: "shard", EndingSequenceNumber: "100"},
	)

	oldLease, err := coordinator.Acquire(ctx, "shard", "worker-old")
	if err != nil {
		t.Fatalf("Acquire old: %v", err)
	}
	if oldLease.Generation != 1 {
		t.Fatalf("first generation = %d, want 1", oldLease.Generation)
	}

	clock.Advance(11 * time.Second)
	newLease, err := coordinator.Acquire(ctx, "shard", "worker-new")
	if err != nil {
		t.Fatalf("Acquire new: %v", err)
	}
	if newLease.Generation <= oldLease.Generation {
		t.Fatalf("new generation = %d, old = %d", newLease.Generation, oldLease.Generation)
	}

	if _, err := coordinator.Commit(ctx, oldLease, Progress{
		Watermark: "10",
		OutputAck: "10",
	}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale commit error = %v, want ErrLeaseLost", err)
	}
	if _, err := coordinator.Renew(ctx, oldLease); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale renew error = %v, want ErrLeaseLost", err)
	}
	if err := coordinator.Release(ctx, oldLease); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale release error = %v, want ErrLeaseLost", err)
	}
	state, err := coordinator.State(ctx, "shard")
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Watermark != "" {
		t.Fatalf("stale commit advanced watermark: %+v", state)
	}

	if _, err := coordinator.Commit(ctx, newLease, Progress{
		Watermark: "10",
		OutputAck: "10",
	}); err != nil {
		t.Fatalf("current lease commit: %v", err)
	}
}

func TestActiveLeaseCannotBePreempted(t *testing.T) {
	ctx := context.Background()
	coordinator, clock, _ := newTestCoordinator(t,
		Shard{ShardID: "shard"},
	)
	lease, err := coordinator.Acquire(ctx, "shard", "worker-1")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}

	clock.Advance(5 * time.Second)
	_, err = coordinator.Acquire(ctx, "shard", "worker-2")
	var held *LeaseHeldError
	if !errors.As(err, &held) {
		t.Fatalf("Acquire during active lease = %v, want LeaseHeldError", err)
	}
	if held.Lease.Generation != lease.Generation {
		t.Fatalf("reported lease = %+v, want generation %d", held.Lease, lease.Generation)
	}

	renewed, err := coordinator.Renew(ctx, lease)
	if err != nil {
		t.Fatalf("Renew: %v", err)
	}
	if renewed.Generation != lease.Generation {
		t.Fatalf("renew changed generation from %d to %d", lease.Generation, renewed.Generation)
	}
}

func TestExpiredLeaseCannotRenewOrCommit(t *testing.T) {
	ctx := context.Background()
	coordinator, clock, _ := newTestCoordinator(t,
		Shard{ShardID: "shard"},
	)
	lease, err := coordinator.Acquire(ctx, "shard", "worker")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	clock.Advance(11 * time.Second)

	if _, err := coordinator.Renew(ctx, lease); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("Renew expired = %v, want ErrLeaseExpired", err)
	}
	if _, err := coordinator.Commit(ctx, lease, Progress{
		Watermark: "1",
		OutputAck: "1",
	}); !errors.Is(err, ErrLeaseExpired) {
		t.Fatalf("Commit expired = %v, want ErrLeaseExpired", err)
	}
}

func TestReleaseRetainsGeneration(t *testing.T) {
	ctx := context.Background()
	coordinator, _, _ := newTestCoordinator(t,
		Shard{ShardID: "shard"},
	)
	first, err := coordinator.Acquire(ctx, "shard", "worker")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	if err := coordinator.Release(ctx, first); err != nil {
		t.Fatalf("Release: %v", err)
	}
	second, err := coordinator.Acquire(ctx, "shard", "worker")
	if err != nil {
		t.Fatalf("Acquire after release: %v", err)
	}
	if second.Generation <= first.Generation {
		t.Fatalf("generation after release = %d, want > %d", second.Generation, first.Generation)
	}
	if _, err := coordinator.Commit(ctx, first, Progress{
		Watermark: "1",
		OutputAck: "1",
	}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("released lease commit = %v, want ErrLeaseLost", err)
	}
}

func TestRenewExtendsLeaseWithoutChangingGeneration(t *testing.T) {
	ctx := context.Background()
	coordinator, clock, _ := newTestCoordinator(t,
		Shard{ShardID: "shard"},
	)
	lease, err := coordinator.Acquire(ctx, "shard", "worker")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	clock.Advance(8 * time.Second)
	renewed, err := coordinator.RenewFor(ctx, lease, 20*time.Second)
	if err != nil {
		t.Fatalf("RenewFor: %v", err)
	}
	if renewed.Generation != lease.Generation {
		t.Fatalf("renew changed generation from %d to %d", lease.Generation, renewed.Generation)
	}
	clock.Advance(15 * time.Second)
	if _, err := coordinator.Commit(ctx, lease, Progress{
		Watermark: "1",
		OutputAck: "1",
	}); err != nil {
		t.Fatalf("Commit during renewed lease: %v", err)
	}
}

func TestProgressCannotMoveBackwards(t *testing.T) {
	ctx := context.Background()
	coordinator, _, _ := newTestCoordinator(t,
		Shard{ShardID: "shard"},
	)
	lease, err := coordinator.Acquire(ctx, "shard", "worker")
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	if _, err := coordinator.Commit(ctx, lease, Progress{
		Watermark: "20",
		OutputAck: "20",
	}); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if _, err := coordinator.Commit(ctx, lease, Progress{
		Watermark: "19",
		OutputAck: "19",
	}); !errors.Is(err, ErrProgressRegression) {
		t.Fatalf("regressing commit = %v, want ErrProgressRegression", err)
	}
}

func TestCoordinatorsShareLeaseGenerationsThroughStore(t *testing.T) {
	ctx := context.Background()
	clock := newFakeClock()
	store := NewMemoryStore()
	graph, err := NewShardGraph(Shard{ShardID: "shard", EndingSequenceNumber: "100"})
	if err != nil {
		t.Fatalf("NewShardGraph: %v", err)
	}
	first := NewCoordinator(store, WithGraph(graph), WithClock(clock), WithLeaseTTL(10*time.Second))
	second := NewCoordinator(store, WithGraph(graph), WithClock(clock), WithLeaseTTL(10*time.Second))

	firstLease, err := first.Acquire(ctx, "shard", "worker-1")
	if err != nil {
		t.Fatalf("first Acquire: %v", err)
	}
	if _, err := second.Acquire(ctx, "shard", "worker-2"); !errors.Is(err, ErrLeaseHeld) {
		t.Fatalf("second Acquire while active = %v, want ErrLeaseHeld", err)
	}

	clock.Advance(11 * time.Second)
	secondLease, err := second.Acquire(ctx, "shard", "worker-2")
	if err != nil {
		t.Fatalf("second Acquire after expiry: %v", err)
	}
	if secondLease.Generation <= firstLease.Generation {
		t.Fatalf("shared store did not advance generation: %d -> %d",
			firstLease.Generation, secondLease.Generation)
	}
	if _, err := first.Commit(ctx, firstLease, Progress{
		Watermark: "10",
		OutputAck: "10",
	}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("old coordinator commit = %v, want ErrLeaseLost", err)
	}
	if _, err := second.Commit(ctx, secondLease, Progress{
		Watermark: "100",
		OutputAck: "100",
	}); err != nil {
		t.Fatalf("new coordinator commit: %v", err)
	}
	if _, err := first.Commit(ctx, firstLease, Progress{
		Watermark: "100",
		OutputAck: "100",
	}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale commit after completion = %v, want ErrLeaseLost", err)
	}
	if _, err := second.Commit(ctx, secondLease, Progress{
		Watermark: "100",
		OutputAck: "100",
	}); !errors.Is(err, ErrShardCompleted) {
		t.Fatalf("current commit after completion = %v, want ErrShardCompleted", err)
	}
}

func TestConcurrentAcquireHasSingleWinner(t *testing.T) {
	ctx := context.Background()
	coordinator, _, _ := newTestCoordinator(t,
		Shard{ShardID: "shard"},
	)

	const workers = 64
	start := make(chan struct{})
	results := make(chan error, workers)
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func(index int) {
			defer wg.Done()
			<-start
			_, err := coordinator.Acquire(ctx, "shard", workerName(index))
			results <- err
		}(i)
	}
	close(start)
	wg.Wait()
	close(results)

	successes := 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrLeaseHeld):
		default:
			t.Fatalf("unexpected Acquire error: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("successful acquisitions = %d, want 1", successes)
	}
}

func workerName(index int) string {
	const digits = "0123456789"
	if index == 0 {
		return "worker-0"
	}
	var buf [8]byte
	pos := len(buf)
	for index > 0 {
		pos--
		buf[pos] = digits[index%10]
		index /= 10
	}
	return "worker-" + string(buf[pos:])
}
