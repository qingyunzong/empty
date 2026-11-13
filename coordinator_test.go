package dataeng

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestAssignProcessesEveryRecordExactlyOnce(t *testing.T) {
	source := newTestSource(map[PartitionID][]Record{
		0: recordsFor(0, 5),
		1: recordsFor(1, 5),
	})
	sink := newRecordingSink()
	committer := newRecordingCommitter()
	c := mustNew(t, Config{
		Reader: source, Sink: sink, Committer: committer,
		BatchSize: 2, PollInterval: time.Millisecond,
	})

	if err := c.Assign(context.Background(),
		Assignment{Partition: 0, Generation: 1},
		Assignment{Partition: 1, Generation: 1},
	); err != nil {
		t.Fatalf("Assign: %v", err)
	}
	waitWatermark(t, c, 0, 5)
	waitWatermark(t, c, 1, 5)

	if err := c.Revoke(context.Background(), 0, 1); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	sink.assertCoverage(t, 0, 5)
	sink.assertCoverage(t, 1, 5)
	if got := committer.offset(0); got != 5 {
		t.Fatalf("partition 0 committed offset = %d, want 5", got)
	}
	if got := committer.offset(1); got != 5 {
		t.Fatalf("partition 1 committed offset = %d, want 5", got)
	}

	fetches0 := source.fetchCount(0)
	fetches1 := source.fetchCount(1)
	time.Sleep(20 * time.Millisecond)
	if source.fetchCount(0) != fetches0 || source.fetchCount(1) != fetches1 {
		t.Fatal("worker kept fetching after revoke returned")
	}
	closeCoordinator(t, c)
}

func TestRevokeStopsReadsAndWaitsForInFlightCommit(t *testing.T) {
	source := newTestSource(map[PartitionID][]Record{0: recordsFor(0, 6)})
	sink := newBlockingSink("0:0:2")
	committer := newRecordingCommitter()
	c := mustNew(t, Config{
		Reader: source, Sink: sink, Committer: committer,
		BatchSize: 2, PollInterval: time.Millisecond,
	})
	if err := c.Assign(context.Background(), Assignment{Partition: 0, Generation: 1}); err != nil {
		t.Fatalf("Assign: %v", err)
	}

	select {
	case batch := <-sink.submitted:
		if batch.ID != "0:0:2" {
			t.Fatalf("first batch = %q, want 0:0:2", batch.ID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("sink never received the first batch")
	}
	fetchesBefore := source.fetchCount(0)

	revokeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.Revoke(revokeCtx, 0) }()
	waitFor(t, 2*time.Second, "revoke to start", func() bool {
		status, ok := c.Status(0)
		return ok && status.Revoking
	})

	select {
	case err := <-done:
		t.Fatalf("Revoke returned before in-flight commit finished: %v", err)
	case <-time.After(40 * time.Millisecond):
	}
	if got := source.fetchCount(0); got != fetchesBefore {
		t.Fatalf("reader was called %d times during revoke; want %d", got, fetchesBefore)
	}

	if !sink.release("0:0:2") {
		t.Fatal("no pending sink commit to release")
	}
	if err := <-done; err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	waitWatermark(t, c, 0, 2)
	if got := committer.offset(0); got != 2 {
		t.Fatalf("committed offset = %d, want 2", got)
	}

	fetchesAfter := source.fetchCount(0)
	time.Sleep(20 * time.Millisecond)
	if got := source.fetchCount(0); got != fetchesAfter {
		t.Fatalf("reader was called %d times after revoke; want %d", got, fetchesAfter)
	}
	closeCoordinator(t, c)
}

func TestCooperativeRebalanceKeepsOtherPartitionsRunning(t *testing.T) {
	source := newTestSource(map[PartitionID][]Record{
		0: recordsFor(0, 4),
		1: recordsFor(1, 4),
	})
	sink := newBlockingSink("0:0:2")
	committer := newRecordingCommitter()
	c := mustNew(t, Config{
		Reader: source, Sink: sink, Committer: committer,
		BatchSize: 2, PollInterval: time.Millisecond,
	})
	if err := c.Assign(context.Background(),
		Assignment{Partition: 0, Generation: 1},
		Assignment{Partition: 1, Generation: 1},
	); err != nil {
		t.Fatalf("Assign: %v", err)
	}
	deadline := time.After(5 * time.Second)
waitLoop:
	for {
		select {
		case batch := <-sink.submitted:
			if batch.Partition == 0 {
				break waitLoop
			}
		case <-deadline:
			t.Fatal("sink never received partition 0 batch")
		}
	}

	revokeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.Revoke(revokeCtx, 0) }()
	waitFor(t, 2*time.Second, "revoke to start", func() bool {
		status, ok := c.Status(0)
		return ok && status.Revoking
	})

	// Partition 1 must make progress while partition 0 drains.
	waitWatermark(t, c, 1, 4)
	select {
	case err := <-done:
		t.Fatalf("partition 0 revoke finished before its commit completed: %v", err)
	case <-time.After(20 * time.Millisecond):
	}

	if !sink.release("0:0:2") {
		t.Fatal("no pending sink commit to release")
	}
	if err := <-done; err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	status, _ := c.Status(1)
	if !status.Active || status.Watermark != 4 {
		t.Fatalf("partition 1 was disturbed by partition 0 revoke: %+v", status)
	}
	closeCoordinator(t, c)
}

func TestLateCallbackCannotAdvanceNewOwnerWatermark(t *testing.T) {
	source := newTestSource(map[PartitionID][]Record{0: recordsFor(0, 6)})
	source.limit = func(_ PartitionID, call int) int {
		if call == 0 {
			return 6
		}
		return 2
	}
	resume := make(chan struct{})
	source.fetchGate = resume
	source.gateAfter = 2

	sink := newBlockingSink("0:0:6")
	committer := newRecordingCommitter()
	c := mustNew(t, Config{
		Reader: source, Sink: sink, Committer: committer,
		BatchSize: 6, PollInterval: time.Millisecond,
		CommitTimeout: 5 * time.Second,
	})
	if err := c.Assign(context.Background(), Assignment{Partition: 0, Generation: 1}); err != nil {
		t.Fatalf("Assign epoch 1: %v", err)
	}
	select {
	case batch := <-sink.submitted:
		if batch.ID != "0:0:6" {
			t.Fatalf("first batch = %q, want 0:0:6", batch.ID)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("sink never received first batch")
	}

	revokeCtx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if err := c.Revoke(revokeCtx, 0); !errors.Is(err, ErrRevokeTimeout) {
		t.Fatalf("Revoke = %v, want ErrRevokeTimeout", err)
	}
	oldStatus, _ := c.Status(0)

	// The new owner starts at the same Kafka offset. Recovery must not
	// resubmit the old batch because it is still in flight in this process.
	if err := c.Assign(context.Background(), Assignment{Partition: 0, Generation: 2}); err != nil {
		t.Fatalf("Assign epoch 2: %v", err)
	}
	newStatus, _ := c.Status(0)
	if newStatus.Epoch <= oldStatus.Epoch {
		t.Fatalf("new epoch %d did not fence old epoch %d", newStatus.Epoch, oldStatus.Epoch)
	}
	waitWatermark(t, c, 0, 2)

	// The old sink finishes after the new owner has committed [0,2).
	if !sink.release("0:0:6") {
		t.Fatal("no pending sink commit to release")
	}
	waitFor(t, 2*time.Second, "fenced journal event", func() bool {
		events, err := c.cfg.Journal.Replay(context.Background())
		if err != nil {
			return false
		}
		for _, event := range events {
			if event.Kind == EventFenced && event.BatchID == "0:0:6" {
				return true
			}
		}
		return false
	})
	status, _ := c.Status(0)
	if status.Watermark != 2 {
		t.Fatalf("late callback advanced new owner watermark to %d, want 2", status.Watermark)
	}
	if got := committer.offset(0); got != 2 {
		t.Fatalf("late callback committed offset %d, want 2", got)
	}

	close(resume)
	waitWatermark(t, c, 0, 6)
	if got := committer.offset(0); got != 6 {
		t.Fatalf("final committed offset = %d, want 6", got)
	}
	closeCoordinator(t, c)
}

func TestLostFencesOldLease(t *testing.T) {
	source := newTestSource(map[PartitionID][]Record{0: recordsFor(0, 4)})
	sink := newBlockingSink("0:0:2")
	committer := newRecordingCommitter()
	c := mustNew(t, Config{
		Reader: source, Sink: sink, Committer: committer,
		BatchSize: 2, PollInterval: time.Millisecond,
	})
	if err := c.Assign(context.Background(), Assignment{Partition: 0, Generation: 1}); err != nil {
		t.Fatalf("Assign: %v", err)
	}
	select {
	case <-sink.submitted:
	case <-time.After(5 * time.Second):
		t.Fatal("sink never received first batch")
	}
	c.Lost(0)

	if err := c.Assign(context.Background(), Assignment{Partition: 0, Generation: 2}); err != nil {
		t.Fatalf("Assign epoch 2: %v", err)
	}
	waitWatermark(t, c, 0, 4)
	if !sink.release("0:0:2") {
		t.Fatalf("expected a late callback for the old lease")
	}
	time.Sleep(20 * time.Millisecond)
	status, _ := c.Status(0)
	if status.Watermark != 4 {
		t.Fatalf("watermark = %d, want 4", status.Watermark)
	}
	closeCoordinator(t, c)
}
