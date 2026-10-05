package aggregator

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestBarrierRecordsBatchesAndAcks(t *testing.T) {
	barrier := NewBarrier()
	ctx := context.Background()

	go barrier.Send(ctx, Batch{Seq: 0, Items: []any{"a", "b"}})
	go barrier.Send(ctx, Batch{Seq: 1, Items: []any{"c"}})
	if err := barrier.WaitSent(ctx, 2); err != nil {
		t.Fatal(err)
	}

	batches := barrier.Batches()
	if len(batches) != 2 {
		t.Fatalf("sent %d batches, want 2", len(batches))
	}
	if got := batches[0].Items; len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("batch 0 items = %v, want [a b]", got)
	}
	if got := batches[1].Items; len(got) != 1 || got[0] != "c" {
		t.Fatalf("batch 1 items = %v, want [c]", got)
	}

	// Ack out of order: range stops at the first gap.
	barrier.Complete(1, nil)
	if lo, hi := barrier.AckedRange(0); lo != 0 || hi != 0 {
		t.Fatalf("AckedRange after acking 1 = (%d,%d), want (0,0)", lo, hi)
	}
	barrier.Complete(0, errors.New("boom"))
	if lo, hi := barrier.AckedRange(0); lo != 0 || hi != 2 {
		t.Fatalf("AckedRange after acking 0 = (%d,%d), want (0,2)", lo, hi)
	}
	if got := barrier.Acked(); len(got) != 2 || got[0] != 1 || got[1] != 0 {
		t.Fatalf("Acked = %v, want [1 0]", got)
	}
}

func TestBarrierWaitSentTimeout(t *testing.T) {
	barrier := NewBarrier()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := barrier.WaitSent(ctx, 1); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("WaitSent = %v, want DeadlineExceeded", err)
	}
}
