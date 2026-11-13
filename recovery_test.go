package dataeng

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type failingCommitter struct {
	mu       sync.Mutex
	failures int
	next     map[PartitionID]Offset
}

func newFailingCommitter(failures int) *failingCommitter {
	return &failingCommitter{failures: failures, next: make(map[PartitionID]Offset)}
}

func (c *failingCommitter) CommitOffset(_ context.Context, partition PartitionID, next Offset) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.failures > 0 {
		c.failures--
		return errors.New("injected offset-commit failure")
	}
	if next > c.next[partition] {
		c.next[partition] = next
	}
	return nil
}

func TestRecoveryResumesAfterOffsetCommitFailure(t *testing.T) {
	dir := t.TempDir()
	journalPath := filepath.Join(dir, "journal.log")
	journal, err := OpenFileJournal(journalPath)
	if err != nil {
		t.Fatalf("OpenFileJournal: %v", err)
	}

	source := newTestSource(map[PartitionID][]Record{0: recordsFor(0, 4)})
	sink := newRecordingSink()
	committer := newFailingCommitter(1)
	c := mustNew(t, Config{
		Reader: source, Sink: sink, Committer: committer, Journal: journal,
		BatchSize: 2, PollInterval: time.Millisecond,
	})
	if err := c.Assign(context.Background(), Assignment{Partition: 0, Generation: 1}); err != nil {
		t.Fatalf("Assign: %v", err)
	}
	waitFor(t, 5*time.Second, "injected commit failure", func() bool {
		status, ok := c.Status(0)
		return ok && status.LastError != nil
	})
	// The sink committed [0,2) but the offset commit failed, so recovery must
	// reuse the recorded receipt rather than submit the batch again.
	if got := sink.submitCount("0:0:2"); got != 1 {
		t.Fatalf("first batch submitted %d times, want 1", got)
	}
	closeCoordinator(t, c)

	journal, err = OpenFileJournal(journalPath)
	if err != nil {
		t.Fatalf("reopen journal: %v", err)
	}
	committer2 := newRecordingCommitter()
	c2 := mustNew(t, Config{
		Reader: source, Sink: sink, Committer: committer2, Journal: journal,
		BatchSize: 2, PollInterval: time.Millisecond,
	})
	if err := c2.Assign(context.Background(), Assignment{Partition: 0, Generation: 2}); err != nil {
		t.Fatalf("Assign after recovery: %v", err)
	}
	waitWatermark(t, c2, 0, 4)
	if got := committer2.offset(0); got != 4 {
		t.Fatalf("recovered committed offset = %d, want 4", got)
	}
	if got := sink.submitCount("0:0:2"); got != 1 {
		t.Fatalf("recovered batch was resubmitted %d times, want 1", got)
	}
	if got := sink.submitCount("0:2:4"); got != 1 {
		t.Fatalf("second batch submitted %d times, want 1", got)
	}
	sink.assertCoverage(t, 0, 4)

	events, err := journal.Replay(context.Background())
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	var recoveredOffset bool
	for _, event := range events {
		if event.Kind == EventOffsetCommitted && event.BatchID == "0:0:2" {
			recoveredOffset = true
		}
	}
	if !recoveredOffset {
		t.Fatal("recovery did not journal the recovered offset commit")
	}
	closeCoordinator(t, c2)
}
