package loglib

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

// writeResult is the test-controlled outcome of one Write call.
type writeResult struct {
	n   int
	err error
}

// writeCall is one Write observed by the controlledWriter. The call
// completes only when the test sends a result on respond.
type writeCall struct {
	data    []byte
	respond chan<- writeResult
}

// controlledWriter announces every Write on calls and blocks until the
// test responds, so tests decide when and in which order writes finish.
type controlledWriter struct {
	calls chan writeCall

	mu    sync.Mutex
	syncs int
}

func newControlledWriter() *controlledWriter {
	return &controlledWriter{calls: make(chan writeCall)}
}

func (w *controlledWriter) Write(p []byte) (int, error) {
	respond := make(chan writeResult, 1)
	w.calls <- writeCall{data: append([]byte(nil), p...), respond: respond}
	r := <-respond
	return r.n, r.err
}

func (w *controlledWriter) Sync() error {
	w.mu.Lock()
	w.syncs++
	w.mu.Unlock()
	return nil
}

func (w *controlledWriter) syncCount() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.syncs
}

func recvCall(t *testing.T, w *controlledWriter) writeCall {
	t.Helper()
	select {
	case c := <-w.calls:
		return c
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for a write call")
		return writeCall{}
	}
}

// waiter tracks one Flush call and its single terminal state.
type waiter struct {
	res chan error
}

func spawnWaiter(l *Log, ctx context.Context, n uint64) *waiter {
	w := &waiter{res: make(chan error, 1)}
	go func() { w.res <- l.Flush(ctx, n) }()
	return w
}

func (w *waiter) expectPending(t *testing.T) {
	t.Helper()
	select {
	case err := <-w.res:
		t.Fatalf("waiter finished unexpectedly with %v", err)
	case <-time.After(50 * time.Millisecond):
	}
}

// expectDone asserts the waiter reaches exactly one terminal state and
// that it matches want.
func (w *waiter) expectDone(t *testing.T, want error) {
	t.Helper()
	select {
	case err := <-w.res:
		if !errors.Is(err, want) {
			t.Fatalf("waiter finished with %v, want %v", err, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("waiter did not finish, want %v", want)
	}
	select {
	case err := <-w.res:
		t.Fatalf("waiter reported a second terminal state: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
}

func waitForAcked(t *testing.T, l *Log, want uint64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if l.Acked() == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("acked = %d, want %d", l.Acked(), want)
}

func TestAppendAssignsConsecutiveSequences(t *testing.T) {
	w := newControlledWriter()
	l := New(w)

	for want := uint64(1); want <= 3; want++ {
		seq, err := l.Append([]byte{byte(want)})
		if err != nil {
			t.Fatalf("Append: %v", err)
		}
		if seq != want {
			t.Fatalf("Append returned seq %d, want %d", seq, want)
		}
	}

	for i := 0; i < 3; i++ {
		c := recvCall(t, w)
		c.respond <- writeResult{n: len(c.data)}
	}
	waitForAcked(t, l, 3)
}

func TestOutOfOrderCompletionConfirmsPrefix(t *testing.T) {
	w := newControlledWriter()
	l := New(w)

	for _, rec := range []string{"record-1", "record-2", "record-3"} {
		if _, err := l.Append([]byte(rec)); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	w1 := spawnWaiter(l, context.Background(), 1)
	w2 := spawnWaiter(l, context.Background(), 2)
	w3 := spawnWaiter(l, context.Background(), 3)

	calls := make(map[string]writeCall)
	for i := 0; i < 3; i++ {
		c := recvCall(t, w)
		calls[string(c.data)] = c
	}

	// Complete record-3 first: the confirmed prefix must not move.
	c := calls["record-3"]
	c.respond <- writeResult{n: len(c.data)}
	w1.expectPending(t)
	w2.expectPending(t)
	w3.expectPending(t)
	if got := l.Acked(); got != 0 {
		t.Fatalf("acked = %d after out-of-order record-3, want 0", got)
	}

	// Complete record-1: only the first barrier releases.
	c = calls["record-1"]
	c.respond <- writeResult{n: len(c.data)}
	w1.expectDone(t, nil)
	w2.expectPending(t)
	w3.expectPending(t)
	if got := l.Acked(); got != 1 {
		t.Fatalf("acked = %d after record-1, want 1", got)
	}

	// Complete record-2: the prefix extends across record-3 as well.
	c = calls["record-2"]
	c.respond <- writeResult{n: len(c.data)}
	w2.expectDone(t, nil)
	w3.expectDone(t, nil)
	if got := l.Acked(); got != 3 {
		t.Fatalf("acked = %d after record-2, want 3", got)
	}
	if got := w.syncCount(); got != 3 {
		t.Fatalf("syncs = %d, want 3", got)
	}
}

func TestCancelWaitDoesNotCancelWrite(t *testing.T) {
	w := newControlledWriter()
	l := New(w)

	if _, err := l.Append([]byte("record-1")); err != nil {
		t.Fatalf("Append: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	wt := spawnWaiter(l, ctx, 1)

	c := recvCall(t, w)
	cancel()
	wt.expectDone(t, context.Canceled)

	// The write is still in flight and completes normally.
	c.respond <- writeResult{n: len(c.data)}
	waitForAcked(t, l, 1)

	// A fresh waiter observes the already-synced record.
	wt2 := spawnWaiter(l, context.Background(), 1)
	wt2.expectDone(t, nil)
}

func TestShortWriteFailsAffectedBarriers(t *testing.T) {
	w := newControlledWriter()
	l := New(w)

	for _, rec := range []string{"record-1", "record-2", "record-3"} {
		if _, err := l.Append([]byte(rec)); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}

	w1 := spawnWaiter(l, context.Background(), 1)
	w2 := spawnWaiter(l, context.Background(), 2)
	w3 := spawnWaiter(l, context.Background(), 3)

	calls := make(map[string]writeCall)
	for i := 0; i < 3; i++ {
		c := recvCall(t, w)
		calls[string(c.data)] = c
	}

	c := calls["record-1"]
	c.respond <- writeResult{n: len(c.data)}
	w1.expectDone(t, nil)

	// Short write on record-2 without an explicit error.
	c = calls["record-2"]
	c.respond <- writeResult{n: len(c.data) - 1}
	w2.expectDone(t, io.ErrShortWrite)
	w3.expectDone(t, io.ErrShortWrite)

	// record-3 still completes, but the prefix is stuck before record-2.
	c = calls["record-3"]
	c.respond <- writeResult{n: len(c.data)}
	waitForAcked(t, l, 1)

	// Late waiters see the same terminal states immediately.
	spawnWaiter(l, context.Background(), 1).expectDone(t, nil)
	spawnWaiter(l, context.Background(), 2).expectDone(t, io.ErrShortWrite)
	spawnWaiter(l, context.Background(), 3).expectDone(t, io.ErrShortWrite)
}

func TestFlushZeroSucceedsImmediately(t *testing.T) {
	l := New(newControlledWriter())
	if err := l.Flush(context.Background(), 0); err != nil {
		t.Fatalf("Flush(0): %v", err)
	}
}
