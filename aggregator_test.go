package aggregator_test

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"aggregator"
)

// collectSender records every batch it receives on a channel.
func collectSender(buf int) (aggregator.SendFunc[int], chan aggregator.Batch[int]) {
	ch := make(chan aggregator.Batch[int], buf)
	return func(_ context.Context, b aggregator.Batch[int]) error {
		ch <- b
		return nil
	}, ch
}

// gateSender optionally announces each send on started, blocks the sequence
// on its gate, then returns the configured error for that sequence.
type gateSender struct {
	started chan uint64
	gates   map[uint64]chan struct{}
	errs    map[uint64]error
}

func (g gateSender) send(_ context.Context, b aggregator.Batch[int]) error {
	if g.started != nil {
		g.started <- b.Seq()
	}
	if ch, ok := g.gates[b.Seq()]; ok {
		<-ch
	}
	return g.errs[b.Seq()]
}

func recvBatch(t *testing.T, ch chan aggregator.Batch[int]) aggregator.Batch[int] {
	t.Helper()
	select {
	case b := <-ch:
		return b
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for batch")
		return aggregator.Batch[int]{}
	}
}

func recvErr(t *testing.T, ch chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for result")
		return nil
	}
}

func assertBlocked(t *testing.T, ch chan error, what string) {
	t.Helper()
	select {
	case err := <-ch:
		t.Fatalf("%s returned early with %v", what, err)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestSealsByCapacity(t *testing.T) {
	send, sent := collectSender(2)
	a, err := aggregator.New[int](3, 0, nil, send)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Add(1); err != nil {
		t.Fatal(err)
	}
	if err := a.Add(2); err != nil {
		t.Fatal(err)
	}
	select {
	case b := <-sent:
		t.Fatalf("batch sealed before capacity: %v", b.Items())
	default:
	}
	if err := a.Add(3); err != nil {
		t.Fatal(err)
	}
	b := recvBatch(t, sent)
	if b.Seq() != 1 || !reflect.DeepEqual(b.Items(), []int{1, 2, 3}) {
		t.Fatalf("batch 1 = seq %d items %v", b.Seq(), b.Items())
	}
	if err := a.Add(4); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	b = recvBatch(t, sent)
	if b.Seq() != 2 || !reflect.DeepEqual(b.Items(), []int{4}) {
		t.Fatalf("batch 2 = seq %d items %v", b.Seq(), b.Items())
	}
}

func TestSealsByVirtualTimeout(t *testing.T) {
	clk := aggregator.NewManualClock(time.Unix(0, 0))
	send, sent := collectSender(2)
	a, err := aggregator.New[int](10, 5*time.Second, clk, send)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Add(1); err != nil {
		t.Fatal(err)
	}
	if err := a.Add(2); err != nil {
		t.Fatal(err)
	}
	clk.Advance(4 * time.Second)
	select {
	case b := <-sent:
		t.Fatalf("batch sealed before virtual timeout: %v", b.Items())
	default:
	}
	clk.Advance(1 * time.Second)
	b := recvBatch(t, sent)
	if b.Seq() != 1 || !reflect.DeepEqual(b.Items(), []int{1, 2}) {
		t.Fatalf("batch 1 = seq %d items %v", b.Seq(), b.Items())
	}

	// The next batch's timeout starts from its own first item.
	if err := a.Add(3); err != nil {
		t.Fatal(err)
	}
	clk.Advance(4 * time.Second)
	select {
	case b := <-sent:
		t.Fatalf("batch 2 sealed early: %v", b.Items())
	default:
	}
	clk.Advance(1 * time.Second)
	b = recvBatch(t, sent)
	if b.Seq() != 2 || !reflect.DeepEqual(b.Items(), []int{3}) {
		t.Fatalf("batch 2 = seq %d items %v", b.Seq(), b.Items())
	}
	if err := a.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestSealedBatchImmutable(t *testing.T) {
	send, sent := collectSender(1)
	a, err := aggregator.New[int](3, 0, nil, send)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []int{1, 2, 3} {
		if err := a.Add(v); err != nil {
			t.Fatal(err)
		}
	}
	b := recvBatch(t, sent)
	items := b.Items()
	items[0] = 99
	if got := b.Items(); !reflect.DeepEqual(got, []int{1, 2, 3}) {
		t.Fatalf("sealed batch mutated: %v", got)
	}
	// Items added after the seal land in a new batch.
	if err := a.Add(4); err != nil {
		t.Fatal(err)
	}
	if got := b.Items(); !reflect.DeepEqual(got, []int{1, 2, 3}) {
		t.Fatalf("sealed batch changed by later Add: %v", got)
	}
	if err := a.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestFlushWaitsForEarlierBatchesOnly(t *testing.T) {
	gate1, gate2 := make(chan struct{}), make(chan struct{})
	started := make(chan uint64, 2)
	sender := gateSender{started: started, gates: map[uint64]chan struct{}{1: gate1, 2: gate2}}
	a, err := aggregator.New[int](2, 0, nil, sender.send)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Add(1); err != nil {
		t.Fatal(err)
	}

	// Flush seals batch 1 itself; the started signal proves Flush's snapshot
	// (maxSeq = 1) is taken before batch 2 exists.
	flushed := make(chan error, 1)
	go func() { flushed <- a.Flush(context.Background()) }()
	select {
	case seq := <-started:
		if seq != 1 {
			t.Fatalf("sender started with seq %d, want 1", seq)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Flush did not seal and dispatch batch 1")
	}

	// Batch 2 is sealed after Flush's snapshot, so Flush must not wait for it.
	if err := a.Add(3); err != nil {
		t.Fatal(err)
	}
	if err := a.Add(4); err != nil {
		t.Fatal(err)
	}
	assertBlocked(t, flushed, "Flush")

	close(gate1)
	if err := recvErr(t, flushed); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	close(gate2)
	if err := a.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestFlushReturnsFirstSequenceFailure(t *testing.T) {
	errB := errors.New("boom-2")
	errC := errors.New("boom-3")
	gate2, gate3 := make(chan struct{}), make(chan struct{})
	sender := gateSender{
		gates: map[uint64]chan struct{}{2: gate2, 3: gate3},
		errs:  map[uint64]error{2: errB, 3: errC},
	}
	a, err := aggregator.New[int](2, 0, nil, sender.send)
	if err != nil {
		t.Fatal(err)
	}
	for v := 1; v <= 6; v++ {
		if err := a.Add(v); err != nil {
			t.Fatal(err)
		}
	}
	// Complete out of order: batch 3 fails before batch 2.
	close(gate3)
	close(gate2)

	err = a.Flush(context.Background())
	var sendErr *aggregator.SendError
	if !errors.As(err, &sendErr) {
		t.Fatalf("Flush error = %v, want *SendError", err)
	}
	if sendErr.Seq != 2 {
		t.Fatalf("SendError.Seq = %d, want first failed sequence 2", sendErr.Seq)
	}
	if !errors.Is(err, errB) {
		t.Fatalf("Flush error %v does not wrap batch 2 failure", err)
	}
	if err := a.Close(context.Background()); err == nil {
		t.Fatal("Close should report the recorded failure")
	}
}

func TestCloseDrains(t *testing.T) {
	gate := make(chan struct{})
	sender := gateSender{gates: map[uint64]chan struct{}{1: gate}}
	a, err := aggregator.New[int](2, 0, nil, sender.send)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Add(1); err != nil {
		t.Fatal(err)
	}
	if err := a.Add(2); err != nil {
		t.Fatal(err)
	} // batch 1 in flight, blocked

	closed := make(chan error, 1)
	go func() { closed <- a.Close(context.Background()) }()

	// Poll until Close takes effect; any item accepted meanwhile is drained
	// by Close as a trailing batch.
	deadline := time.Now().Add(2 * time.Second)
	for {
		if err := a.Add(3); errors.Is(err, aggregator.ErrClosed) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Close did not take effect")
		}
		time.Sleep(time.Millisecond)
	}
	assertBlocked(t, closed, "Close")

	close(gate)
	if err := recvErr(t, closed); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Close is idempotent and already drained.
	if err := a.Close(context.Background()); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestCancelWaitDoesNotCancelBatch(t *testing.T) {
	gate := make(chan struct{})
	var mu sync.Mutex
	sent := 0
	sender := func(_ context.Context, b aggregator.Batch[int]) error {
		<-gate
		mu.Lock()
		sent++
		mu.Unlock()
		return nil
	}
	a, err := aggregator.New[int](2, 0, nil, sender)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Add(1); err != nil {
		t.Fatal(err)
	}
	if err := a.Add(2); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	flushed := make(chan error, 1)
	go func() { flushed <- a.Flush(ctx) }()
	cancel()
	if err := recvErr(t, flushed); !errors.Is(err, context.Canceled) {
		t.Fatalf("Flush with cancelled ctx = %v, want context.Canceled", err)
	}

	// The batch itself was not cancelled: releasing the gate lets the send
	// complete, and a fresh wait observes success.
	close(gate)
	if err := a.Flush(context.Background()); err != nil {
		t.Fatalf("second Flush: %v", err)
	}
	mu.Lock()
	if sent != 1 {
		t.Fatalf("sender called %d times, want 1", sent)
	}
	mu.Unlock()
	if err := a.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestBarrierChecksBatchingAndAckRange(t *testing.T) {
	send, _ := collectSender(4)
	a, err := aggregator.New[int](2, 0, nil, send)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []int{1, 2, 3} {
		if err := a.Add(v); err != nil {
			t.Fatal(err)
		}
	}
	rep, err := a.Barrier(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := aggregator.Report{Batches: 2, Sizes: []int{2, 1}, AckLo: 1, AckHi: 2}
	if !reflect.DeepEqual(rep, want) {
		t.Fatalf("Report = %+v, want %+v", rep, want)
	}
	if err := a.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestBarrierReportsAckRangeShortfall(t *testing.T) {
	errB := errors.New("boom-2")
	sender := gateSender{errs: map[uint64]error{2: errB}}
	a, err := aggregator.New[int](2, 0, nil, sender.send)
	if err != nil {
		t.Fatal(err)
	}
	for v := 1; v <= 4; v++ {
		if err := a.Add(v); err != nil {
			t.Fatal(err)
		}
	}
	rep, err := a.Barrier(context.Background())
	var sendErr *aggregator.SendError
	if !errors.As(err, &sendErr) || sendErr.Seq != 2 {
		t.Fatalf("Barrier error = %v, want *SendError with Seq 2", err)
	}
	if rep.Batches != 2 || !reflect.DeepEqual(rep.Sizes, []int{2, 2}) {
		t.Fatalf("Report batches = %+v", rep)
	}
	if rep.AckLo != 1 || rep.AckHi != 1 {
		t.Fatalf("ack range = [%d, %d], want [1, 1]", rep.AckLo, rep.AckHi)
	}
}

func TestFlushEmptyIsNoop(t *testing.T) {
	a, err := aggregator.New[int](4, 0, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	rep, err := a.Barrier(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rep.Batches != 0 || rep.AckHi != 0 {
		t.Fatalf("Report = %+v, want empty", rep)
	}
	if err := a.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}
