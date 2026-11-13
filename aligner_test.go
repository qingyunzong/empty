package dataeng

import (
	"errors"
	"reflect"
	"testing"
)

func rec(v int) Record { return Record{Value: v} }

func values(records []Record) []int {
	out := make([]int, 0, len(records))
	for _, r := range records {
		out = append(out, r.Value.(int))
	}
	return out
}

func mustAligner(t *testing.T, channels int) *BarrierAligner {
	t.Helper()
	a, err := NewBarrierAligner(channels)
	if err != nil {
		t.Fatalf("NewBarrierAligner(%d): %v", channels, err)
	}
	return a
}

func mustRecord(t *testing.T, a *BarrierAligner, ch int, v int) Result {
	t.Helper()
	res, err := a.ProcessRecord(ch, rec(v))
	if err != nil {
		t.Fatalf("ProcessRecord(%d, %d): %v", ch, v, err)
	}
	return res
}

func mustBarrier(t *testing.T, a *BarrierAligner, ch int, b Barrier) Result {
	t.Helper()
	res, err := a.ProcessBarrier(ch, b)
	if err != nil {
		t.Fatalf("ProcessBarrier(%d, %+v): %v", ch, b, err)
	}
	return res
}

func TestAlignedCheckpointBuffersAndReleases(t *testing.T) {
	a := mustAligner(t, 2)

	if res := mustRecord(t, a, 0, 1); len(res.Emit) != 1 {
		t.Fatalf("record before barrier: got %d emits, want 1", len(res.Emit))
	}
	if res := mustBarrier(t, a, 0, NewBarrier(1)); res.Snapshot != nil {
		t.Fatal("snapshot fired before all channels reported")
	}
	if res := mustRecord(t, a, 0, 2); len(res.Emit) != 0 {
		t.Fatal("post-barrier record on blocked channel was emitted")
	}
	if res := mustRecord(t, a, 1, 3); len(res.Emit) != 1 {
		t.Fatal("record on unblocked channel was held back")
	}

	res := mustBarrier(t, a, 1, NewBarrier(1))
	if res.Snapshot == nil || res.Snapshot.CheckpointID != 1 {
		t.Fatalf("snapshot = %+v, want checkpoint 1", res.Snapshot)
	}
	if got := values(res.Emit); !reflect.DeepEqual(got, []int{2}) {
		t.Fatalf("released records = %v, want [2]", got)
	}
	if !a.IsCompleted(1) {
		t.Fatal("checkpoint 1 not marked completed")
	}
	if _, pending := a.Pending(); pending {
		t.Fatal("aligner still pending after completion")
	}
}

func TestAlignedReleasePreservesArrivalOrder(t *testing.T) {
	a := mustAligner(t, 3)

	mustBarrier(t, a, 0, NewBarrier(7))
	mustRecord(t, a, 0, 10)
	mustBarrier(t, a, 1, NewBarrier(7))
	mustRecord(t, a, 1, 20)
	mustRecord(t, a, 0, 11)
	mustRecord(t, a, 2, 30) // channel 2 not yet blocked
	mustRecord(t, a, 1, 21)

	res := mustBarrier(t, a, 2, NewBarrier(7))
	if res.Snapshot == nil {
		t.Fatal("checkpoint 7 did not complete")
	}
	if got := values(res.Emit); !reflect.DeepEqual(got, []int{10, 20, 11, 21}) {
		t.Fatalf("released records = %v, want arrival order [10 20 11 21]", got)
	}
}

func TestUnalignedCheckpointCapturesInflight(t *testing.T) {
	a := mustAligner(t, 2)

	mustBarrier(t, a, 0, NewUnalignedBarrier(3))
	if res := mustRecord(t, a, 0, 5); len(res.Emit) != 1 {
		t.Fatal("unaligned checkpoint blocked a record")
	}
	if res := mustRecord(t, a, 1, 6); len(res.Emit) != 1 {
		t.Fatal("unaligned checkpoint blocked a record")
	}

	res := mustBarrier(t, a, 1, NewUnalignedBarrier(3))
	if res.Snapshot == nil || res.Snapshot.CheckpointID != 3 {
		t.Fatalf("snapshot = %+v, want checkpoint 3", res.Snapshot)
	}
	if got := values(res.Snapshot.Inflight); !reflect.DeepEqual(got, []int{5, 6}) {
		t.Fatalf("inflight = %v, want [5 6]", got)
	}
	if len(res.Emit) != 0 {
		t.Fatal("unaligned completion emitted records")
	}

	// After completion records flow without being captured.
	if res := mustRecord(t, a, 0, 7); len(res.Emit) != 1 {
		t.Fatal("record after completion was not passed through")
	}
}

func TestCheckpointCompletesOnlyOnce(t *testing.T) {
	a := mustAligner(t, 2)

	mustBarrier(t, a, 0, NewBarrier(1))
	if res := mustBarrier(t, a, 1, NewBarrier(1)); res.Snapshot == nil {
		t.Fatal("checkpoint 1 did not complete")
	}

	// Duplicate barriers for the finished checkpoint (e.g. resent
	// after recovery) must not trigger a second snapshot.
	for _, ch := range []int{0, 1} {
		if res := mustBarrier(t, a, ch, NewBarrier(1)); res.Snapshot != nil {
			t.Fatalf("checkpoint 1 completed twice (channel %d)", ch)
		}
	}
}

func TestCancellationAbortsPendingCheckpoint(t *testing.T) {
	a := mustAligner(t, 2)

	mustBarrier(t, a, 0, NewBarrier(4))
	mustRecord(t, a, 0, 8)
	mustRecord(t, a, 0, 9)

	res := mustBarrier(t, a, 1, NewCancellation(4))
	if res.Snapshot != nil {
		t.Fatal("cancelled checkpoint produced a snapshot")
	}
	if got := values(res.Emit); !reflect.DeepEqual(got, []int{8, 9}) {
		t.Fatalf("abort released %v, want [8 9]", got)
	}
	if a.IsCompleted(4) {
		t.Fatal("cancelled checkpoint marked completed")
	}
	if _, pending := a.Pending(); pending {
		t.Fatal("aligner still pending after abort")
	}

	// A later checkpoint proceeds normally.
	mustBarrier(t, a, 0, NewBarrier(5))
	if res := mustBarrier(t, a, 1, NewBarrier(5)); res.Snapshot == nil {
		t.Fatal("checkpoint 5 did not complete after abort of 4")
	}
}

func TestCancellationCannotRevokeCommittedSnapshot(t *testing.T) {
	a := mustAligner(t, 2)

	mustBarrier(t, a, 0, NewBarrier(1))
	res := mustBarrier(t, a, 1, NewBarrier(1))
	if res.Snapshot == nil {
		t.Fatal("checkpoint 1 did not complete")
	}

	// A cancellation arriving after completion must be a no-op.
	late := mustBarrier(t, a, 0, NewCancellation(1))
	if late.Snapshot != nil || len(late.Emit) != 0 {
		t.Fatalf("late cancellation had an effect: %+v", late)
	}
	if !a.IsCompleted(1) {
		t.Fatal("late cancellation revoked a committed snapshot")
	}

	// Cancellation for an unknown checkpoint is also a no-op.
	if res := mustBarrier(t, a, 0, NewCancellation(99)); res.Snapshot != nil || len(res.Emit) != 0 {
		t.Fatalf("unknown cancellation had an effect: %+v", res)
	}
}

func TestNewerCheckpointSupersedesPending(t *testing.T) {
	a := mustAligner(t, 2)

	mustBarrier(t, a, 0, NewBarrier(1))
	mustRecord(t, a, 0, 42)

	// Checkpoint 2 arrives before checkpoint 1 aligned: 1 is aborted
	// and its buffered records released in order.
	res := mustBarrier(t, a, 1, NewBarrier(2))
	if res.Snapshot != nil {
		t.Fatal("superseding barrier completed a checkpoint early")
	}
	if got := values(res.Emit); !reflect.DeepEqual(got, []int{42}) {
		t.Fatalf("supersede released %v, want [42]", got)
	}
	if id, pending := a.Pending(); !pending || id != 2 {
		t.Fatalf("pending = (%d, %v), want (2, true)", id, pending)
	}

	if res := mustBarrier(t, a, 0, NewBarrier(2)); res.Snapshot == nil {
		t.Fatal("checkpoint 2 did not complete")
	}
	if a.IsCompleted(1) {
		t.Fatal("superseded checkpoint 1 marked completed")
	}

	// A late barrier for the superseded checkpoint is ignored.
	if res := mustBarrier(t, a, 0, NewBarrier(1)); res.Snapshot != nil || len(res.Emit) != 0 {
		t.Fatalf("late barrier had an effect: %+v", res)
	}
}

func TestProtocolViolations(t *testing.T) {
	a := mustAligner(t, 2)

	if _, err := a.ProcessRecord(2, rec(1)); !errors.Is(err, ErrChannelOutOfRange) {
		t.Fatalf("record on bad channel: %v", err)
	}
	if _, err := a.ProcessBarrier(-1, NewBarrier(1)); !errors.Is(err, ErrChannelOutOfRange) {
		t.Fatalf("barrier on bad channel: %v", err)
	}

	mustBarrier(t, a, 0, NewBarrier(1))
	if _, err := a.ProcessBarrier(0, NewBarrier(1)); err == nil {
		t.Fatal("duplicate barrier on same channel accepted")
	}
	if _, err := a.ProcessBarrier(1, NewUnalignedBarrier(1)); err == nil {
		t.Fatal("mixed aligned/unaligned barriers accepted")
	}

	if _, err := NewBarrierAligner(0); err == nil {
		t.Fatal("zero-channel aligner accepted")
	}
}

func TestSingleChannelCompletesImmediately(t *testing.T) {
	a := mustAligner(t, 1)
	res := mustBarrier(t, a, 0, NewBarrier(9))
	if res.Snapshot == nil || res.Snapshot.CheckpointID != 9 {
		t.Fatalf("single-channel checkpoint did not complete immediately: %+v", res)
	}
}
