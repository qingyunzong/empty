package aggregator

import (
	"context"
	"errors"
	"testing"
	"time"
)

func addAll(t *testing.T, a *Aggregator, items ...any) {
	t.Helper()
	for _, item := range items {
		if err := a.Add(item); err != nil {
			t.Fatalf("Add(%v) = %v", item, err)
		}
	}
}

func TestSealByCapacity(t *testing.T) {
	barrier := NewBarrier()
	a := New(Options{Capacity: 3, Sender: barrier.Send})
	ctx := context.Background()

	addAll(t, a, "a", "b")
	if got := len(barrier.Batches()); got != 0 {
		t.Fatalf("sent %d batches before capacity, want 0", got)
	}
	addAll(t, a, "c")
	if err := barrier.WaitSent(ctx, 1); err != nil {
		t.Fatal(err)
	}
	batch := barrier.Batches()[0]
	if batch.Seq != 0 {
		t.Fatalf("seq = %d, want 0", batch.Seq)
	}
	if got := batch.Items; len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Fatalf("items = %v, want [a b c]", got)
	}
	barrier.Complete(0, nil)
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestSealByVirtualTimeout(t *testing.T) {
	clock := NewVirtualClock(time.Unix(0, 0))
	barrier := NewBarrier()
	a := New(Options{Timeout: 10 * time.Millisecond, Clock: clock, Sender: barrier.Send})
	ctx := context.Background()

	addAll(t, a, "a", "b")
	clock.Advance(9 * time.Millisecond)
	if got := len(barrier.Batches()); got != 0 {
		t.Fatalf("sent %d batches before timeout, want 0", got)
	}
	clock.Advance(time.Millisecond)
	if err := barrier.WaitSent(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if got := barrier.Batches()[0].Items; len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("items = %v, want [a b]", got)
	}

	// The next batch gets a fresh timeout window.
	addAll(t, a, "c")
	clock.Advance(9 * time.Millisecond)
	if got := len(barrier.Batches()); got != 1 {
		t.Fatalf("sent %d batches before second timeout, want 1", got)
	}
	clock.Advance(time.Millisecond)
	if err := barrier.WaitSent(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if got := barrier.Batches()[1].Items; len(got) != 1 || got[0] != "c" {
		t.Fatalf("items = %v, want [c]", got)
	}
	barrier.Complete(0, nil)
	barrier.Complete(1, nil)
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestSealedBatchImmutable(t *testing.T) {
	barrier := NewBarrier()
	a := New(Options{Capacity: 2, Sender: barrier.Send})
	ctx := context.Background()

	addAll(t, a, "a", "b")
	if err := barrier.WaitSent(ctx, 1); err != nil {
		t.Fatal(err)
	}
	sealed := barrier.Batches()[0]

	addAll(t, a, "c", "d")
	if err := barrier.WaitSent(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if got := sealed.Items; len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("sealed batch changed to %v, want [a b]", got)
	}
	barrier.Complete(0, nil)
	barrier.Complete(1, nil)
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestFlushWaitsForEarlierBatches(t *testing.T) {
	barrier := NewBarrier()
	a := New(Options{Capacity: 1, Sender: barrier.Send})
	ctx := context.Background()

	addAll(t, a, "a", "b")
	if err := barrier.WaitSent(ctx, 2); err != nil {
		t.Fatal(err)
	}

	flushed := make(chan error, 1)
	go func() { flushed <- a.Flush(ctx) }()

	// Completing the later batch first must not unblock Flush.
	barrier.Complete(1, nil)
	select {
	case err := <-flushed:
		t.Fatalf("Flush returned %v before earlier batch completed", err)
	case <-time.After(20 * time.Millisecond):
	}

	barrier.Complete(0, nil)
	select {
	case err := <-flushed:
		if err != nil {
			t.Fatalf("Flush = %v, want nil", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Flush did not return after all batches completed")
	}
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestOutOfOrderFailureReturnsFirstSequence(t *testing.T) {
	barrier := NewBarrier()
	a := New(Options{Capacity: 1, Sender: barrier.Send})
	ctx := context.Background()

	addAll(t, a, "a", "b", "c")
	if err := barrier.WaitSent(ctx, 3); err != nil {
		t.Fatal(err)
	}

	errFirst := errors.New("seq 1 failed")
	errLater := errors.New("seq 2 failed")
	// Complete out of order; the earliest failing sequence wins even
	// though the later failure is recorded first.
	barrier.Complete(2, errLater)
	barrier.Complete(1, errFirst)
	barrier.Complete(0, nil)

	if err := a.Flush(ctx); !errors.Is(err, errFirst) {
		t.Fatalf("Flush = %v, want %v", err, errFirst)
	}
	if err := a.Close(ctx); !errors.Is(err, errFirst) {
		t.Fatalf("Close = %v, want %v", err, errFirst)
	}
}

func TestFlushCancelDoesNotCancelBatches(t *testing.T) {
	barrier := NewBarrier()
	a := New(Options{Capacity: 1, Sender: barrier.Send})
	ctx := context.Background()

	addAll(t, a, "a")
	if err := barrier.WaitSent(ctx, 1); err != nil {
		t.Fatal(err)
	}

	waitCtx, cancel := context.WithCancel(ctx)
	flushed := make(chan error, 1)
	go func() { flushed <- a.Flush(waitCtx) }()
	cancel()
	if err := <-flushed; !errors.Is(err, context.Canceled) {
		t.Fatalf("Flush = %v, want context.Canceled", err)
	}

	// The batch is still in flight and its result is observed later.
	want := errors.New("send failed")
	barrier.Complete(0, want)
	if err := a.Flush(ctx); !errors.Is(err, want) {
		t.Fatalf("Flush after cancel = %v, want %v", err, want)
	}
	if err := a.Close(ctx); !errors.Is(err, want) {
		t.Fatalf("Close = %v, want %v", err, want)
	}
}

func TestCloseDrains(t *testing.T) {
	barrier := NewBarrier()
	a := New(Options{Capacity: 10, Sender: barrier.Send})
	ctx := context.Background()

	addAll(t, a, "a", "b", "c")
	closed := make(chan error, 1)
	go func() { closed <- a.Close(ctx) }()

	// Close seals the partial batch and waits for its send.
	if err := barrier.WaitSent(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if got := barrier.Batches()[0].Items; len(got) != 3 {
		t.Fatalf("drained batch items = %v, want 3 items", got)
	}
	select {
	case err := <-closed:
		t.Fatalf("Close returned %v before send completed", err)
	case <-time.After(20 * time.Millisecond):
	}
	barrier.Complete(0, nil)
	if err := <-closed; err != nil {
		t.Fatalf("Close = %v, want nil", err)
	}

	if err := a.Add("x"); !errors.Is(err, ErrClosed) {
		t.Fatalf("Add after Close = %v, want ErrClosed", err)
	}
	if err := a.Close(ctx); err != nil {
		t.Fatalf("second Close = %v, want nil", err)
	}
	if err := a.Flush(ctx); err != nil {
		t.Fatalf("Flush after Close = %v, want nil", err)
	}
}

func TestCloseCancelKeepsBatches(t *testing.T) {
	barrier := NewBarrier()
	a := New(Options{Capacity: 1, Sender: barrier.Send})
	ctx := context.Background()

	addAll(t, a, "a")
	if err := barrier.WaitSent(ctx, 1); err != nil {
		t.Fatal(err)
	}

	waitCtx, cancel := context.WithCancel(ctx)
	closed := make(chan error, 1)
	go func() { closed <- a.Close(waitCtx) }()
	cancel()
	if err := <-closed; !errors.Is(err, context.Canceled) {
		t.Fatalf("Close = %v, want context.Canceled", err)
	}

	// The batch keeps running; a later Close observes its result.
	barrier.Complete(0, nil)
	if err := a.Close(ctx); err != nil {
		t.Fatalf("second Close = %v, want nil", err)
	}
}

func TestBatchPartitioningAndAckRange(t *testing.T) {
	barrier := NewBarrier()
	a := New(Options{Capacity: 2, Sender: barrier.Send})
	ctx := context.Background()

	addAll(t, a, 1, 2, 3, 4, 5)
	flushed := make(chan error, 1)
	go func() { flushed <- a.Flush(ctx) }()
	if err := barrier.WaitSent(ctx, 3); err != nil {
		t.Fatal(err)
	}

	want := [][]any{{1, 2}, {3, 4}, {5}}
	for i, batch := range barrier.Batches() {
		if batch.Seq != i {
			t.Fatalf("batch %d seq = %d", i, batch.Seq)
		}
		if len(batch.Items) != len(want[i]) {
			t.Fatalf("batch %d items = %v, want %v", i, batch.Items, want[i])
		}
		for j, item := range batch.Items {
			if item != want[i][j] {
				t.Fatalf("batch %d items = %v, want %v", i, batch.Items, want[i])
			}
		}
	}

	barrier.Complete(0, nil)
	barrier.Complete(2, nil)
	if lo, hi := barrier.AckedRange(0); lo != 0 || hi != 1 {
		t.Fatalf("AckedRange = (%d,%d), want (0,1)", lo, hi)
	}
	barrier.Complete(1, nil)
	if lo, hi := barrier.AckedRange(0); lo != 0 || hi != 3 {
		t.Fatalf("AckedRange = (%d,%d), want (0,3)", lo, hi)
	}
	if err := <-flushed; err != nil {
		t.Fatalf("Flush = %v, want nil", err)
	}
	if err := a.Close(ctx); err != nil {
		t.Fatal(err)
	}
}
