package dataeng

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileJournalSurvivesReopenAndTornTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.log")
	journal, err := OpenFileJournal(path)
	if err != nil {
		t.Fatalf("OpenFileJournal: %v", err)
	}
	ctx := context.Background()
	events := []Event{
		{
			Kind: EventBegin, BatchID: "0:0:2", Partition: 0, Generation: 1, Epoch: 1,
			First: 0, Next: 2,
			Output: []OutputRecord{{Key: []byte("k"), Value: []byte("v")}},
		},
		{Kind: EventSinkCommitted, BatchID: "0:0:2", Partition: 0, Generation: 1, Epoch: 1, First: 0, Next: 2},
		{Kind: EventFenced, BatchID: "0:0:2", Partition: 0, Generation: 1, Epoch: 1, First: 0, Next: 2},
	}
	for _, event := range events {
		if err := journal.Append(ctx, event); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}
	if err := journal.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Simulate a crash during the next append: leave an unterminated frame.
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open raw journal: %v", err)
	}
	if _, err := file.WriteString("deadbeef {\"kind\":\"begin\""); err != nil {
		t.Fatalf("write torn tail: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close raw journal: %v", err)
	}

	journal, err = OpenFileJournal(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	replayed, err := journal.Replay(ctx)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if len(replayed) != len(events) {
		t.Fatalf("replayed %d events, want %d", len(replayed), len(events))
	}
	for i := range events {
		if replayed[i].Kind != events[i].Kind || replayed[i].BatchID != events[i].BatchID {
			t.Fatalf("event %d = %+v, want kind %s batch %s", i, replayed[i], events[i].Kind, events[i].BatchID)
		}
	}
	if got := replayed[0].Output[0].Value; string(got) != "v" {
		t.Fatalf("replayed output value = %q, want v", got)
	}

	// The torn tail was truncated, so appends resume at a valid frame.
	if err := journal.Append(ctx, Event{Kind: EventBegin, BatchID: "0:2:4", Partition: 0, First: 2, Next: 4}); err != nil {
		t.Fatalf("append after recovery: %v", err)
	}
	replayed, err = journal.Replay(ctx)
	if err != nil {
		t.Fatalf("Replay after append: %v", err)
	}
	if len(replayed) != len(events)+1 {
		t.Fatalf("replayed %d events, want %d", len(replayed), len(events)+1)
	}
	if err := journal.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestFileJournalAssignsMonotonicSequence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal.log")
	journal, err := OpenFileJournal(path)
	if err != nil {
		t.Fatalf("OpenFileJournal: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for i := 0; i < 3; i++ {
		if err := journal.Append(ctx, Event{Kind: EventBegin, BatchID: "0:0:1", Partition: 0}); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}
	events, err := journal.Replay(ctx)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	for i, event := range events {
		if event.Seq != uint64(i+1) {
			t.Fatalf("event %d seq = %d, want %d", i, event.Seq, i+1)
		}
		if event.At.IsZero() {
			t.Fatalf("event %d has zero timestamp", i)
		}
	}
	if err := journal.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}
