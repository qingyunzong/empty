package synclog

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

// gateWriter is a controllable Writer. Every WriteSync call blocks until the
// test releases the record's gate, so completions can be forced out of order.
type gateWriter struct {
	mu      sync.Mutex
	gates   map[string]chan struct{}
	short   map[string]int   // record -> byte count to report (short write)
	errs    map[string]error // record -> error to return
	written []string
}

func newGateWriter() *gateWriter {
	return &gateWriter{
		gates: make(map[string]chan struct{}),
		short: make(map[string]int),
		errs:  make(map[string]error),
	}
}

func (g *gateWriter) gateFor(rec string) chan struct{} {
	g.mu.Lock()
	defer g.mu.Unlock()
	ch, ok := g.gates[rec]
	if !ok {
		ch = make(chan struct{})
		g.gates[rec] = ch
	}
	return ch
}

func (g *gateWriter) release(rec string) { close(g.gateFor(rec)) }

func (g *gateWriter) WriteSync(rec []byte) (int, error) {
	<-g.gateFor(string(rec))
	g.mu.Lock()
	defer g.mu.Unlock()
	g.written = append(g.written, string(rec))
	if err := g.errs[string(rec)]; err != nil {
		return 0, err
	}
	if n, ok := g.short[string(rec)]; ok {
		return n, nil
	}
	return len(rec), nil
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// flushResult collects exactly one terminal state per waiter.
func flushAsync(l *Log, ctx context.Context, n uint64) chan error {
	ch := make(chan error, 2) // buffered to detect double delivery
	go func() { ch <- l.Flush(ctx, n) }()
	return ch
}

func recvOne(t *testing.T, what string, ch chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
		return nil
	}
}

// expectUnique asserts the waiter delivered exactly one terminal state.
func expectUnique(t *testing.T, what string, ch chan error, want error) {
	t.Helper()
	if got := recvOne(t, what, ch); !errors.Is(got, want) {
		t.Fatalf("%s: got %v, want %v", what, got, want)
	}
	select {
	case extra := <-ch:
		t.Fatalf("%s: unexpected second terminal state %v", what, extra)
	case <-time.After(50 * time.Millisecond):
	}
}

func rec(i int) string { return fmt.Sprintf("r%d", i) }

func TestAppendAssignsConsecutiveSeq(t *testing.T) {
	g := newGateWriter()
	l := New(g)
	for i := 1; i <= 5; i++ {
		if seq := l.Append([]byte(rec(i))); seq != uint64(i) {
			t.Fatalf("append %d: got seq %d", i, seq)
		}
	}
}

func TestFlushOutOfOrderCompletion(t *testing.T) {
	g := newGateWriter()
	l := New(g)
	for i := 1; i <= 5; i++ {
		l.Append([]byte(rec(i)))
	}

	w2 := flushAsync(l, context.Background(), 2)
	w3 := flushAsync(l, context.Background(), 3)
	w5 := flushAsync(l, context.Background(), 5)

	// Complete 3 first: prefix cannot advance past the gap at 1.
	g.release(rec(3))
	time.Sleep(20 * time.Millisecond)
	if p := l.Prefix(); p != 0 {
		t.Fatalf("prefix after releasing 3: got %d, want 0", p)
	}

	// Complete 1: prefix = 1, no waiter satisfied yet.
	g.release(rec(1))
	waitFor(t, "prefix 1", func() bool { return l.Prefix() == 1 })
	select {
	case err := <-w2:
		t.Fatalf("waiter n=2 finished early with %v", err)
	default:
	}

	// Complete 2: prefix jumps to 3, waiters n=2 and n=3 succeed once each.
	g.release(rec(2))
	expectUnique(t, "waiter n=2", w2, nil)
	expectUnique(t, "waiter n=3", w3, nil)
	if p := l.Prefix(); p != 3 {
		t.Fatalf("prefix after releasing 2: got %d, want 3", p)
	}

	// Complete 5 before 4: prefix stuck at 3, waiter n=5 still pending.
	g.release(rec(5))
	time.Sleep(20 * time.Millisecond)
	if p := l.Prefix(); p != 3 {
		t.Fatalf("prefix after releasing 5: got %d, want 3", p)
	}
	select {
	case err := <-w5:
		t.Fatalf("waiter n=5 finished early with %v", err)
	default:
	}

	// Complete 4: prefix reaches 5, waiter n=5 succeeds exactly once.
	g.release(rec(4))
	expectUnique(t, "waiter n=5", w5, nil)
	if p := l.Prefix(); p != 5 {
		t.Fatalf("final prefix: got %d, want 5", p)
	}
}

func TestCancelWaitDoesNotCancelWrite(t *testing.T) {
	g := newGateWriter()
	l := New(g)
	l.Append([]byte(rec(1)))

	ctx, cancel := context.WithCancel(context.Background())
	w := flushAsync(l, ctx, 1)
	cancel()
	if err := recvOne(t, "canceled waiter", w); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled waiter: got %v, want context.Canceled", err)
	}

	// The write itself survives cancellation and still lands.
	g.release(rec(1))
	waitFor(t, "prefix 1", func() bool { return l.Prefix() == 1 })
	if err := l.Flush(context.Background(), 1); err != nil {
		t.Fatalf("flush after canceled wait: got %v, want nil", err)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.written) != 1 || g.written[0] != rec(1) {
		t.Fatalf("writer received %v, want [%s]", g.written, rec(1))
	}
}

func TestShortWriteFailsAffectedBarriers(t *testing.T) {
	g := newGateWriter()
	g.short[rec(2)] = 1 // r2 syncs only 1 of its bytes
	l := New(g)
	for i := 1; i <= 3; i++ {
		l.Append([]byte(rec(i)))
	}

	w1 := flushAsync(l, context.Background(), 1)
	w2 := flushAsync(l, context.Background(), 2)
	w3 := flushAsync(l, context.Background(), 3)

	for i := 1; i <= 3; i++ {
		g.release(rec(i))
	}

	expectUnique(t, "waiter n=1", w1, nil)
	expectUnique(t, "waiter n=2", w2, ErrShortWrite)
	expectUnique(t, "waiter n=3", w3, ErrShortWrite)

	// Late Flush calls observe the same terminal state.
	if err := l.Flush(context.Background(), 2); !errors.Is(err, ErrShortWrite) {
		t.Fatalf("late flush n=2: got %v, want ErrShortWrite", err)
	}
	if err := l.Flush(context.Background(), 1); err != nil {
		t.Fatalf("late flush n=1: got %v, want nil", err)
	}
}

func TestWriteErrorFailsAffectedBarriers(t *testing.T) {
	boom := errors.New("boom")
	g := newGateWriter()
	g.errs[rec(1)] = boom
	l := New(g)
	l.Append([]byte(rec(1)))
	l.Append([]byte(rec(2)))

	w := flushAsync(l, context.Background(), 2)
	g.release(rec(1))
	expectUnique(t, "waiter n=2", w, boom)

	// Record 2 can still sync, but the prefix stays behind the failure.
	g.release(rec(2))
	time.Sleep(20 * time.Millisecond)
	if p := l.Prefix(); p != 0 {
		t.Fatalf("prefix after failure at 1: got %d, want 0", p)
	}
}
