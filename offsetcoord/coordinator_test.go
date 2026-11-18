package offsetcoord_test

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"testing"

	"example.org/dlks/formal/q10052/offsetcoord"
)

// fixedResolver returns canned offsets and can be configured to fail.
type fixedResolver struct {
	offsets map[offsetcoord.TimestampMs]offsetcoord.Offset
	err     error
}

func (r fixedResolver) ResolveOffset(_ context.Context, _ offsetcoord.Partition, timestamp offsetcoord.TimestampMs) (offsetcoord.Offset, error) {
	if r.err != nil {
		return 0, r.err
	}
	return r.offsets[timestamp], nil
}

func TestOrderedCommitAndIdempotency(t *testing.T) {
	// Diagnostic names stay stable for logs and test failure output.
	statusNames := map[offsetcoord.CommitStatus]string{
		offsetcoord.CommitAccepted:        "accepted",
		offsetcoord.CommitStaleGeneration: "stale-generation",
		offsetcoord.CommitRegressed:       "regressed",
	}
	for status, name := range statusNames {
		if status.String() != name {
			t.Fatalf("status %d String() = %q, want %q", status, status.String(), name)
		}
	}
	eventNames := map[offsetcoord.EventKind]string{
		offsetcoord.EventCommitted:      "committed",
		offsetcoord.EventCommitRejected: "commit-rejected",
		offsetcoord.EventReset:          "reset",
		offsetcoord.EventResetFailed:    "reset-failed",
	}
	for kind, name := range eventNames {
		if kind.String() != name {
			t.Fatalf("event kind %d String() = %q, want %q", kind, kind.String(), name)
		}
	}

	coordinator := offsetcoord.New()
	partition := offsetcoord.Partition("orders")

	if _, ok := coordinator.PositionOf(partition); ok {
		t.Fatal("unseen partition should report ok == false")
	}

	first := coordinator.Commit(partition, 0, 10)
	if first.Status != offsetcoord.CommitAccepted || first.Position.Offset != 10 || first.Position.Generation != 0 {
		t.Fatalf("first commit = %+v, want accepted at gen 0 offset 10", first)
	}

	duplicate := coordinator.Commit(partition, 0, 10)
	if duplicate.Status != offsetcoord.CommitAccepted || duplicate.Position.Offset != 10 {
		t.Fatalf("duplicate commit = %+v, want idempotent accepted at offset 10", duplicate)
	}

	regressed := coordinator.Commit(partition, 0, 4)
	if regressed.Status != offsetcoord.CommitRegressed || regressed.Position.Offset != 10 {
		t.Fatalf("regressing commit = %+v, want rejected with offset 10 retained", regressed)
	}

	advanced := coordinator.Commit(partition, 0, 20)
	if advanced.Status != offsetcoord.CommitAccepted || advanced.Position.Offset != 20 {
		t.Fatalf("advancing commit = %+v, want accepted at offset 20", advanced)
	}

	position, ok := coordinator.PositionOf(partition)
	if !ok || position.Generation != 0 || position.Offset != 20 {
		t.Fatalf("final position = %+v ok=%v, want (gen 0, offset 20)", position, ok)
	}
}

func TestGenerationFencingAroundReset(t *testing.T) {
	coordinator := offsetcoord.New()
	partition := offsetcoord.Partition("payments")
	resolver := fixedResolver{offsets: map[offsetcoord.TimestampMs]offsetcoord.Offset{
		1000: 3,
		2000: 9,
	}}

	if result := coordinator.Commit(partition, 0, 40); result.Status != offsetcoord.CommitAccepted {
		t.Fatalf("initial commit = %+v", result)
	}

	afterReset, err := coordinator.Reset(context.Background(), partition, 1000, resolver)
	if err != nil {
		t.Fatalf("reset failed: %v", err)
	}
	if afterReset.Generation != 1 || afterReset.Offset != 3 {
		t.Fatalf("reset position = %+v, want gen 1 offset 3", afterReset)
	}

	// An in-flight receipt from displaced generation zero is fenced off even
	// though offset 41 would have been legal before the reset.
	stale := coordinator.Commit(partition, 0, 41)
	if stale.Status != offsetcoord.CommitStaleGeneration || stale.Position.Generation != 1 || stale.Position.Offset != 3 {
		t.Fatalf("stale commit = %+v, want rejected retaining gen 1 offset 3", stale)
	}

	position, _ := coordinator.PositionOf(partition)
	if position.Generation != 1 || position.Offset != 3 {
		t.Fatalf("position after stale commit = %+v, want (gen 1, offset 3)", position)
	}

	if result := coordinator.Commit(partition, 1, 5); result.Status != offsetcoord.CommitAccepted {
		t.Fatalf("new-generation commit = %+v", result)
	}
	if result := coordinator.Commit(partition, 1, 5); result.Status != offsetcoord.CommitAccepted || result.Position.Offset != 5 {
		t.Fatalf("idempotent new-generation commit = %+v", result)
	}

	second, err := coordinator.Reset(context.Background(), partition, 2000, resolver)
	if err != nil {
		t.Fatalf("second reset failed: %v", err)
	}
	if second.Generation != 2 || second.Offset != 9 {
		t.Fatalf("second reset = %+v, want gen 2 offset 9", second)
	}
	if result := coordinator.Commit(partition, 1, 6); result.Status != offsetcoord.CommitStaleGeneration {
		t.Fatalf("commit from prior generation = %+v, want stale-generation", result)
	}
}

// TestResetInterleavedWithInFlightCommits walks the exact hazard the
// generation fence exists for: old-generation in-flight receipts arriving
// around a reset that moves the numeric offset backwards. Neither the reset
// nor any stale receipt may ever make the visible position roll back.
func TestResetInterleavedWithInFlightCommits(t *testing.T) {
	coordinator := offsetcoord.New()
	partition := offsetcoord.Partition("interleaved")
	resolver := fixedResolver{offsets: map[offsetcoord.TimestampMs]offsetcoord.Offset{
		10: 2,
		20: 0,
	}}

	// Generation zero advances well past where the resets will point.
	for _, offset := range []offsetcoord.Offset{10, 20, 30} {
		if result := coordinator.Commit(partition, 0, offset); result.Status != offsetcoord.CommitAccepted {
			t.Fatalf("gen 0 commit %d = %+v", offset, result)
		}
	}

	// An in-flight gen-zero receipt is still outstanding when the reset lands
	// at the numerically smaller offset 2.
	reset, err := coordinator.Reset(context.Background(), partition, 10, resolver)
	if err != nil || reset.Generation != 1 || reset.Offset != 2 {
		t.Fatalf("reset = %+v err=%v, want gen 1 offset 2", reset, err)
	}
	if result := coordinator.Commit(partition, 0, 31); result.Status != offsetcoord.CommitStaleGeneration {
		t.Fatalf("in-flight gen 0 receipt after reset = %+v, want stale-generation", result)
	}
	if got, _ := coordinator.PositionOf(partition); got.Generation != 1 || got.Offset != 2 {
		t.Fatalf("stale receipt mutated state to %+v", got)
	}

	// Repeated stale receipts and duplicate resets never regress the pair.
	if result := coordinator.Commit(partition, 0, 5); result.Status != offsetcoord.CommitStaleGeneration {
		t.Fatalf("second stale receipt = %+v", result)
	}
	resetAgain, err := coordinator.Reset(context.Background(), partition, 20, resolver)
	if err != nil || resetAgain.Generation != 2 || resetAgain.Offset != 0 {
		t.Fatalf("second reset = %+v err=%v, want gen 2 offset 0", resetAgain, err)
	}

	// Even a receipt aimed at the new generation but below its start is held
	// back by the ordered-commit rule.
	if result := coordinator.Commit(partition, 2, 0); result.Status != offsetcoord.CommitAccepted {
		t.Fatalf("idempotent commit at reset start = %+v", result)
	}
	if result := coordinator.Commit(partition, 2, 0); result.Status != offsetcoord.CommitAccepted {
		t.Fatalf("duplicate reset-start commit = %+v, want idempotent", result)
	}

	final, ok := coordinator.PositionOf(partition)
	if !ok || final.Generation != 2 || final.Offset != 0 {
		t.Fatalf("final position = %+v ok=%v, want (gen 2, offset 0)", final, ok)
	}
}

func TestResetFailuresLeaveStateUntouched(t *testing.T) {
	coordinator := offsetcoord.New()
	partition := offsetcoord.Partition("logs")
	resolveErr := errors.New("broker unavailable")

	coordinator.Commit(partition, 0, 7)

	if _, err := coordinator.Reset(context.Background(), partition, 99, fixedResolver{err: resolveErr}); !errors.Is(err, resolveErr) {
		t.Fatalf("reset error = %v, want wrapped resolver error", err)
	}

	position, ok := coordinator.PositionOf(partition)
	if !ok || position.Generation != 0 || position.Offset != 7 {
		t.Fatalf("position after failed reset = %+v ok=%v, want untouched (gen 0, offset 7)", position, ok)
	}

	if result := coordinator.Commit(partition, 0, 8); result.Status != offsetcoord.CommitAccepted {
		t.Fatalf("commit after failed reset = %+v, want accepted in gen 0", result)
	}

	if _, err := coordinator.Reset(context.Background(), partition, 1, nil); err == nil {
		t.Fatal("reset with nil resolver must fail")
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := coordinator.Reset(cancelled, partition, 1, fixedResolver{err: context.Canceled}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled reset error = %v, want context.Canceled", err)
	}
}

func TestEventHookObservesTransitions(t *testing.T) {
	var events []offsetcoord.Event
	coordinator := offsetcoord.New(offsetcoord.WithEventHook(func(event offsetcoord.Event) {
		events = append(events, event)
	}))
	partition := offsetcoord.Partition("events")

	coordinator.Commit(partition, 0, 1)
	coordinator.Commit(partition, 0, 1)
	coordinator.Commit(partition, 0, 0)
	_, _ = coordinator.Reset(context.Background(), partition, 50, fixedResolver{
		offsets: map[offsetcoord.TimestampMs]offsetcoord.Offset{50: 2},
	})
	coordinator.Commit(partition, 0, 99)
	_, _ = coordinator.Reset(context.Background(), partition, 50, fixedResolver{err: errors.New("boom")})

	wantKinds := []offsetcoord.EventKind{
		offsetcoord.EventCommitted,
		offsetcoord.EventCommitted,
		offsetcoord.EventCommitRejected,
		offsetcoord.EventReset,
		offsetcoord.EventCommitRejected,
		offsetcoord.EventResetFailed,
	}
	if len(events) != len(wantKinds) {
		t.Fatalf("hook received %d events, want %d", len(events), len(wantKinds))
	}
	for index, want := range wantKinds {
		if events[index].Kind != want {
			t.Fatalf("event %d kind = %s, want %s (full sequence: %v)", index, events[index].Kind, want, events)
		}
	}
	if events[2].Status != offsetcoord.CommitRegressed || events[4].Status != offsetcoord.CommitStaleGeneration {
		t.Fatalf("rejection statuses wrong: %+v %+v", events[2], events[4])
	}
}

// recordedOp captures one worker operation together with the coordinator's
// observed outcome, so an arbitrary concurrent interleaving can be replayed
// sequentially through the naive oracle afterwards.
type recordedOp struct {
	commit     bool
	partition  offsetcoord.Partition
	generation offsetcoord.Generation
	offset     offsetcoord.Offset
	timestamp  offsetcoord.TimestampMs
	status     offsetcoord.CommitStatus
}

// TestConcurrentCoordination interleaves resets and in-flight old-generation
// commits from many goroutines. The recorded interleaving is then replayed
// through the naive table and must match the coordinator exactly, while every
// observed snapshot must show a position that never rolls back.
func TestConcurrentCoordination(t *testing.T) {
	const (
		partitions   = 3
		committers   = 8
		opsPerWorker = 200
	)

	recorded := make([]recordedOp, 0, (committers+2)*opsPerWorker)

	coordinator := offsetcoord.New()
	resolver := offsetcoord.OffsetResolverFunc(func(_ context.Context, partition offsetcoord.Partition, timestamp offsetcoord.TimestampMs) (offsetcoord.Offset, error) {
		return offsetcoord.Offset(int(partition[1])*10 + int(timestamp)%17), nil
	})

	var wg sync.WaitGroup
	// serialize makes "coordinator call + record append" one atomic step, so
	// the recorded slice is exactly the linearization order and can be replayed
	// sequentially through the naive oracle. The resolver runs outside it.
	var serialize sync.Mutex

	for worker := 0; worker < 2; worker++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(seed))
			for range opsPerWorker {
				partition := offsetcoord.Partition(fmt.Sprintf("p%d", rng.Intn(partitions)))
				timestamp := offsetcoord.TimestampMs(rng.Intn(20))
				serialize.Lock()
				position, err := coordinator.Reset(context.Background(), partition, timestamp, resolver)
				if err != nil {
					serialize.Unlock()
					t.Errorf("unexpected reset error: %v", err)
					continue
				}
				recorded = append(recorded, recordedOp{
					commit:     false,
					partition:  partition,
					timestamp:  timestamp,
					generation: position.Generation,
					offset:     position.Offset,
				})
				serialize.Unlock()
			}
		}(int64(100 + worker))
	}

	// Committers pin themselves to a generation snapshot that can go stale at
	// any moment, modelling in-flight receipts racing resets.
	for worker := 0; worker < committers; worker++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(seed))
			lastOffset := make(map[offsetcoord.Partition]offsetcoord.Offset)
			for range opsPerWorker {
				partition := offsetcoord.Partition(fmt.Sprintf("p%d", rng.Intn(partitions)))
				position, ok := coordinator.PositionOf(partition)
				generation := position.Generation
				if !ok {
					generation = 0
				}
				offset := lastOffset[partition] + offsetcoord.Offset(rng.Intn(3))
				lastOffset[partition] = offset

				serialize.Lock()
				result := coordinator.Commit(partition, generation, offset)
				if result.Status == offsetcoord.CommitAccepted &&
					(result.Position.Generation != generation || result.Position.Offset != offset) {
					serialize.Unlock()
					t.Errorf("accepted result %+v does not echo requested gen %d offset %d", result, generation, offset)
					continue
				}
				recorded = append(recorded, recordedOp{
					commit:     true,
					partition:  partition,
					generation: generation,
					offset:     offset,
					status:     result.Status,
				})
				serialize.Unlock()
			}
		}(int64(200 + worker))
	}

	// Readers continuously verify atomic visibility and the no-rollback rule.
	stop := make(chan struct{})
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		last := make(map[offsetcoord.Partition]offsetcoord.Position)
		for {
			select {
			case <-stop:
				return
			default:
				for partition, current := range coordinator.Snapshot() {
					previous, ok := last[partition]
					if ok && (current.Generation < previous.Generation ||
						(current.Generation == previous.Generation && current.Offset < previous.Offset)) {
						t.Errorf("observed rollback on %s: %+v -> %+v", partition, previous, current)
						return
					}
					last[partition] = current
				}
			}
		}
	}()

	wg.Wait()
	close(stop)
	<-readerDone

	// Replay the exact interleaving through the naive oracle and require
	// identical decisions and an identical final table.
	naive := newNaiveTable()
	previous := make(map[offsetcoord.Partition]naivePosition)
	for index, op := range recorded {
		if op.commit {
			status, _ := naive.commit(op.partition, op.generation, op.offset)
			if status != op.status {
				t.Fatalf("recorded op %d %+v: naive status %s, coordinator saw %s", index, op, status, op.status)
			}
		} else {
			wantOffset, err := resolver.ResolveOffset(context.Background(), op.partition, op.timestamp)
			if err != nil {
				t.Fatalf("replay resolver error: %v", err)
			}
			want := naive.reset(op.partition, wantOffset)
			if want.generation != op.generation || want.offset != op.offset {
				t.Fatalf("recorded reset op %d %+v: naive gives gen %d offset %d", index, op, want.generation, want.offset)
			}
		}

		current, ok := naive.get(op.partition)
		if !ok {
			continue
		}
		if old, seen := previous[op.partition]; seen {
			if current.generation < old.generation ||
				(current.generation == old.generation && current.offset < old.offset) {
				t.Fatalf("replayed rollback on %s at op %d: %+v -> %+v", op.partition, index, old, current)
			}
		}
		previous[op.partition] = current
	}

	finalSnapshot := coordinator.Snapshot()
	if len(finalSnapshot) != len(naive.positions) {
		t.Fatalf("final partition count = %d, want %d", len(finalSnapshot), len(naive.positions))
	}
	for partition, want := range naive.positions {
		got, ok := coordinator.PositionOf(partition)
		if !ok || got.Generation != want.generation || got.Offset != want.offset {
			t.Fatalf("final %s = %+v ok=%v, want %+v", partition, got, ok, want)
		}
	}
}
