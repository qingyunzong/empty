package locklib

import (
	"context"
	"sync"
	"testing"
	"time"
)

// barrier blocks until exactly n parties arrive, then releases all of them.
type barrier struct {
	mu    sync.Mutex
	n     int
	count int
	open  chan struct{}
}

func newBarrier(n int) *barrier { return &barrier{n: n, open: make(chan struct{})} }

func (b *barrier) wait() {
	b.mu.Lock()
	b.count++
	if b.count == b.n {
		close(b.open)
	}
	b.mu.Unlock()
	<-b.open
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func (l *RWLock) queueLen() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.queue)
}

func (l *RWLock) snapshot() (writer bool, readers int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.writer, l.readers
}

func mustLock(t *testing.T, l *RWLock) {
	t.Helper()
	if err := l.Lock(context.Background()); err != nil {
		t.Fatalf("Lock: %v", err)
	}
}

func mustRLock(t *testing.T, l *RWLock) {
	t.Helper()
	if err := l.RLock(context.Background()); err != nil {
		t.Fatalf("RLock: %v", err)
	}
}

// acquire records name into events upon grant and closes acquired.
func acquire(l *RWLock, kind waiterKind, name string, events *[]string, mu *sync.Mutex, acquired chan<- struct{}) {
	var err error
	if kind == kindRead {
		err = l.RLock(context.Background())
	} else {
		err = l.Lock(context.Background())
	}
	if err != nil {
		return
	}
	mu.Lock()
	*events = append(*events, name)
	mu.Unlock()
	close(acquired)
}

// TestDowngradeBatchGrantOrder verifies that downgrading an exclusive hold
// keeps one read token, batch-grants readers queued before the first writer,
// and never lets later readers overtake that writer.
func TestDowngradeBatchGrantOrder(t *testing.T) {
	l := NewRWLock()
	mustLock(t, l)

	var mu sync.Mutex
	var events []string
	r1Acq := make(chan struct{})
	r2Acq := make(chan struct{})
	wAcq := make(chan struct{})
	r3Acq := make(chan struct{})

	go acquire(l, kindRead, "R1", &events, &mu, r1Acq)
	waitFor(t, "R1 queued", func() bool { return l.queueLen() == 1 })
	go acquire(l, kindRead, "R2", &events, &mu, r2Acq)
	waitFor(t, "R2 queued", func() bool { return l.queueLen() == 2 })
	go acquire(l, kindWrite, "W", &events, &mu, wAcq)
	waitFor(t, "W queued", func() bool { return l.queueLen() == 3 })
	go acquire(l, kindRead, "R3", &events, &mu, r3Acq)
	waitFor(t, "R3 queued", func() bool { return l.queueLen() == 4 })

	if err := l.Downgrade(); err != nil {
		t.Fatalf("Downgrade: %v", err)
	}

	// The downgrader retains exactly one read token; the two readers queued
	// ahead of the writer are batch-granted in the same step, so the shared
	// hold count is 1 (retained) + 2 (batch) = 3.
	if writer, readers := l.snapshot(); writer || readers != 3 {
		t.Fatalf("after downgrade: writer=%v readers=%d, want writer=false readers=3", writer, readers)
	}

	// R1 and R2 must both be granted (batch) before either can pass the
	// barrier; W and R3 must still be waiting.
	bar := newBarrier(2)
	go func() { <-r1Acq; bar.wait() }()
	go func() { <-r2Acq; bar.wait() }()
	waitFor(t, "R1 and R2 both granted at barrier", func() bool {
		bar.mu.Lock()
		defer bar.mu.Unlock()
		return bar.count == 2
	})
	select {
	case <-wAcq:
		t.Fatal("writer granted while readers ahead of it held the lock")
	case <-r3Acq:
		t.Fatal("R3 overtook the queued writer")
	default:
	}

	// Release the two batch-granted readers; the downgrader's token still
	// blocks the writer.
	if err := l.RUnlock(); err != nil {
		t.Fatalf("RUnlock R1: %v", err)
	}
	if err := l.RUnlock(); err != nil {
		t.Fatalf("RUnlock R2: %v", err)
	}
	select {
	case <-wAcq:
		t.Fatal("writer granted while downgrader's read token remained")
	default:
	}

	// Release the downgrader's retained token: W is granted, R3 still waits.
	if err := l.RUnlock(); err != nil {
		t.Fatalf("RUnlock downgrader token: %v", err)
	}
	waitFor(t, "W granted", func() bool {
		select {
		case <-wAcq:
			return true
		default:
			return false
		}
	})
	select {
	case <-r3Acq:
		t.Fatal("R3 granted while writer held the lock")
	default:
	}

	// W releases; R3 is finally granted.
	if err := l.Unlock(); err != nil {
		t.Fatalf("Unlock W: %v", err)
	}
	waitFor(t, "R3 granted", func() bool {
		select {
		case <-r3Acq:
			return true
		default:
			return false
		}
	})
	if err := l.RUnlock(); err != nil {
		t.Fatalf("RUnlock R3: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(events) != 4 {
		t.Fatalf("events = %v, want 4 grants", events)
	}
	head := map[string]bool{events[0]: true, events[1]: true}
	if !head["R1"] || !head["R2"] {
		t.Fatalf("first two grants = %v, want R1 and R2 in some order", events[:2])
	}
	if events[2] != "W" || events[3] != "R3" {
		t.Fatalf("grant order = %v, want [R1 R2] W R3", events)
	}
}

// TestCancelHeadAdvancesQueue verifies that canceling the head waiter removes
// it promptly and lets the queue advance as if it were never there.
func TestCancelHeadAdvancesQueue(t *testing.T) {
	l := NewRWLock()
	mustLock(t, l)

	ctx, cancel := context.WithCancel(context.Background())
	wErr := make(chan error, 1)
	go func() { wErr <- l.Lock(ctx) }()
	waitFor(t, "W1 queued", func() bool { return l.queueLen() == 1 })

	rAcq := make(chan struct{})
	go func() {
		if err := l.RLock(context.Background()); err == nil {
			close(rAcq)
		}
	}()
	waitFor(t, "R1 queued behind W1", func() bool { return l.queueLen() == 2 })

	cancel()
	if err := <-wErr; err != context.Canceled {
		t.Fatalf("canceled Lock returned %v, want context.Canceled", err)
	}
	waitFor(t, "canceled head removed", func() bool { return l.queueLen() == 1 })

	// Releasing the exclusive hold grants R1 immediately; nothing is blocked
	// behind the canceled writer.
	if err := l.Unlock(); err != nil {
		t.Fatalf("Unlock: %v", err)
	}
	waitFor(t, "R1 granted after head cancellation", func() bool {
		select {
		case <-rAcq:
			return true
		default:
			return false
		}
	})
	if err := l.RUnlock(); err != nil {
		t.Fatalf("RUnlock: %v", err)
	}
	if writer, readers := l.snapshot(); writer || readers != 0 || l.queueLen() != 0 {
		t.Fatalf("final state writer=%v readers=%d queue=%d, want all zero", writer, readers, l.queueLen())
	}
}

// TestCancelHeadWriterBehindWriter verifies prompt advancement when the
// canceled head sits ahead of another writer.
func TestCancelHeadWriterBehindWriter(t *testing.T) {
	l := NewRWLock()
	mustLock(t, l)

	ctx, cancel := context.WithCancel(context.Background())
	w1Err := make(chan error, 1)
	go func() { w1Err <- l.Lock(ctx) }()
	waitFor(t, "W1 queued", func() bool { return l.queueLen() == 1 })

	w2Acq := make(chan struct{})
	go func() {
		if err := l.Lock(context.Background()); err == nil {
			close(w2Acq)
		}
	}()
	waitFor(t, "W2 queued", func() bool { return l.queueLen() == 2 })

	cancel()
	if err := <-w1Err; err != context.Canceled {
		t.Fatalf("canceled Lock returned %v, want context.Canceled", err)
	}
	if err := l.Unlock(); err != nil {
		t.Fatalf("Unlock: %v", err)
	}
	waitFor(t, "W2 granted", func() bool {
		select {
		case <-w2Acq:
			return true
		default:
			return false
		}
	})
	if err := l.Unlock(); err != nil {
		t.Fatalf("Unlock W2: %v", err)
	}
}

// TestDoubleReleaseLeavesStateUnchanged verifies that releasing without a
// matching hold reports ErrNotHeld and does not mutate lock state.
func TestDoubleReleaseLeavesStateUnchanged(t *testing.T) {
	l := NewRWLock()

	if err := l.Unlock(); err != ErrNotHeld {
		t.Fatalf("Unlock on free lock = %v, want ErrNotHeld", err)
	}
	if err := l.RUnlock(); err != ErrNotHeld {
		t.Fatalf("RUnlock on free lock = %v, want ErrNotHeld", err)
	}
	if err := l.Downgrade(); err != ErrNotHeld {
		t.Fatalf("Downgrade without exclusive hold = %v, want ErrNotHeld", err)
	}
	if writer, readers := l.snapshot(); writer || readers != 0 {
		t.Fatalf("state changed by invalid releases: writer=%v readers=%d", writer, readers)
	}

	mustLock(t, l)
	if err := l.Unlock(); err != nil {
		t.Fatalf("Unlock: %v", err)
	}
	if err := l.Unlock(); err != ErrNotHeld {
		t.Fatalf("second Unlock = %v, want ErrNotHeld", err)
	}
	if writer, readers := l.snapshot(); writer || readers != 0 {
		t.Fatalf("state changed by double Unlock: writer=%v readers=%d", writer, readers)
	}

	mustRLock(t, l)
	if err := l.RUnlock(); err != nil {
		t.Fatalf("RUnlock: %v", err)
	}
	if err := l.RUnlock(); err != ErrNotHeld {
		t.Fatalf("second RUnlock = %v, want ErrNotHeld", err)
	}
	if writer, readers := l.snapshot(); writer || readers != 0 {
		t.Fatalf("state changed by double RUnlock: writer=%v readers=%d", writer, readers)
	}

	// A downgrade followed by a full release must not be downgradable again.
	mustLock(t, l)
	if err := l.Downgrade(); err != nil {
		t.Fatalf("Downgrade: %v", err)
	}
	if err := l.RUnlock(); err != nil {
		t.Fatalf("RUnlock retained token: %v", err)
	}
	if err := l.Downgrade(); err != ErrNotHeld {
		t.Fatalf("Downgrade after full release = %v, want ErrNotHeld", err)
	}
	if writer, readers := l.snapshot(); writer || readers != 0 || l.queueLen() != 0 {
		t.Fatalf("final state writer=%v readers=%d queue=%d, want all zero", writer, readers, l.queueLen())
	}
}

// TestDowngradeKeepsSharedAccess verifies that after a downgrade other
// readers may still acquire shared holds while writers keep waiting.
func TestDowngradeKeepsSharedAccess(t *testing.T) {
	l := NewRWLock()
	mustLock(t, l)
	if err := l.Downgrade(); err != nil {
		t.Fatalf("Downgrade: %v", err)
	}

	mustRLock(t, l) // joins the retained shared hold
	if writer, readers := l.snapshot(); writer || readers != 2 {
		t.Fatalf("after shared join: writer=%v readers=%d, want writer=false readers=2", writer, readers)
	}

	wAcq := make(chan struct{})
	go func() {
		if err := l.Lock(context.Background()); err == nil {
			close(wAcq)
		}
	}()
	waitFor(t, "writer queued", func() bool { return l.queueLen() == 1 })
	select {
	case <-wAcq:
		t.Fatal("writer granted while shared holds active")
	default:
	}

	if err := l.RUnlock(); err != nil {
		t.Fatalf("RUnlock joined reader: %v", err)
	}
	if err := l.RUnlock(); err != nil {
		t.Fatalf("RUnlock retained token: %v", err)
	}
	waitFor(t, "writer granted after last shared release", func() bool {
		select {
		case <-wAcq:
			return true
		default:
			return false
		}
	})
	if err := l.Unlock(); err != nil {
		t.Fatalf("Unlock: %v", err)
	}
}
