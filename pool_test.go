package connpool

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeConn struct {
	id     int
	closed int32
}

func (f *fakeConn) Close() error {
	atomic.AddInt32(&f.closed, 1)
	return nil
}

func (f *fakeConn) closeCount() int32 { return atomic.LoadInt32(&f.closed) }

func waitFor(t *testing.T, msg string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("condition not met: %s", msg)
}

func (p *Pool) waiterCount(dest string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	ds := p.dests[dest]
	if ds == nil {
		return 0
	}
	n := 0
	for _, tq := range ds.tenants {
		n += len(tq.waiters)
	}
	return n
}

func (p *Pool) idleCount(dest string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.dests[dest].idle)
}

func (p *Pool) cursor(dest string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.dests[dest].cursor
}

type acquireResult struct {
	conn Conn
	err  error
}

// startAcquire launches an Acquire and waits until it is enqueued, so the
// caller controls the exact queue order.
func startAcquire(t *testing.T, p *Pool, ctx context.Context, dest, tenant string, queued int) <-chan acquireResult {
	t.Helper()
	ch := make(chan acquireResult, 1)
	go func() {
		c, err := p.Acquire(ctx, dest, tenant)
		ch <- acquireResult{c, err}
	}()
	waitFor(t, "waiter enqueued", func() bool { return p.waiterCount(dest) == queued })
	return ch
}

func mustAcquire(t *testing.T, ch <-chan acquireResult) acquireResult {
	t.Helper()
	select {
	case r := <-ch:
		return r
	case <-time.After(2 * time.Second):
		t.Fatal("acquire did not resolve")
		return acquireResult{}
	}
}

func TestIdleReuseReturnsConnOnce(t *testing.T) {
	p := New()
	c1 := &fakeConn{id: 1}
	p.Release("d", c1)

	got, err := p.Acquire(context.Background(), "d", "t")
	if err != nil || got != Conn(c1) {
		t.Fatalf("got %v, %v; want c1, nil", got, err)
	}
	if n := p.idleCount("d"); n != 0 {
		t.Fatalf("idle count = %d; conn was returned more than once", n)
	}

	// The conn is gone from the pool: a second acquire must block.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := p.Acquire(ctx, "d", "t"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second acquire err = %v; want DeadlineExceeded", err)
	}
}

func TestFIFOWithinTenant(t *testing.T) {
	p := New()
	w1 := startAcquire(t, p, context.Background(), "d", "t", 1)
	w2 := startAcquire(t, p, context.Background(), "d", "t", 2)

	c1, c2 := &fakeConn{id: 1}, &fakeConn{id: 2}
	p.Release("d", c1)
	if r := mustAcquire(t, w1); r.conn != Conn(c1) {
		t.Fatalf("first waiter got %v; want c1", r.conn)
	}
	p.Release("d", c2)
	if r := mustAcquire(t, w2); r.conn != Conn(c2) {
		t.Fatalf("second waiter got %v; want c2", r.conn)
	}
}

func TestRoundRobinAcrossTenants(t *testing.T) {
	p := New()
	a1 := startAcquire(t, p, context.Background(), "d", "A", 1)
	b1 := startAcquire(t, p, context.Background(), "d", "B", 2)
	a2 := startAcquire(t, p, context.Background(), "d", "A", 3)

	p.Release("d", &fakeConn{id: 1})
	if r := mustAcquire(t, a1); r.err != nil {
		t.Fatal(r.err)
	}
	if got := p.cursor("d"); got != 1 {
		t.Fatalf("cursor = %d; want 1", got)
	}

	p.Release("d", &fakeConn{id: 2})
	if r := mustAcquire(t, b1); r.err != nil {
		t.Fatal(r.err)
	}
	if got := p.cursor("d"); got != 0 {
		t.Fatalf("cursor = %d; want 0", got)
	}

	// Cursor wrapped back to A, not stuck on B.
	p.Release("d", &fakeConn{id: 3})
	if r := mustAcquire(t, a2); r.err != nil {
		t.Fatal(r.err)
	}
	if got := p.cursor("d"); got != 1 {
		t.Fatalf("cursor = %d; want 1", got)
	}
}

func TestCancelSkipsWaiter(t *testing.T) {
	p := New()
	ctx, cancel := context.WithCancel(context.Background())
	w1 := startAcquire(t, p, ctx, "d", "t", 1)
	w2 := startAcquire(t, p, context.Background(), "d", "t", 2)

	cancel()
	if r := mustAcquire(t, w1); !errors.Is(r.err, context.Canceled) {
		t.Fatalf("cancelled waiter err = %v; want Canceled", r.err)
	}

	c1 := &fakeConn{id: 1}
	p.Release("d", c1)
	if r := mustAcquire(t, w2); r.conn != Conn(c1) {
		t.Fatalf("second waiter got %v; want c1 (cancelled waiter skipped)", r.conn)
	}
}

func TestDeliveredCannotBeCancelled(t *testing.T) {
	p := New()
	ctx, cancel := context.WithCancel(context.Background())
	w := startAcquire(t, p, ctx, "d", "t", 1)

	c1 := &fakeConn{id: 1}
	p.Release("d", c1) // delivery wins under the lock
	cancel()           // cancel arrives too late

	r := mustAcquire(t, w)
	if r.err != nil || r.conn != Conn(c1) {
		t.Fatalf("got %v, %v; want delivered c1, nil", r.conn, r.err)
	}
}

func TestCloseRejectsAndWakes(t *testing.T) {
	p := New()
	idle := &fakeConn{id: 0}
	p.Release("d2", idle)
	w1 := startAcquire(t, p, context.Background(), "d", "A", 1)
	w2 := startAcquire(t, p, context.Background(), "d", "B", 2)

	p.Close()

	for i, w := range []<-chan acquireResult{w1, w2} {
		if r := mustAcquire(t, w); !errors.Is(r.err, ErrClosed) {
			t.Fatalf("waiter %d err = %v; want ErrClosed", i, r.err)
		}
	}
	if n := idle.closeCount(); n != 1 {
		t.Fatalf("idle conn closed %d times; want 1", n)
	}
	if _, err := p.Acquire(context.Background(), "d", "A"); !errors.Is(err, ErrClosed) {
		t.Fatalf("acquire after close err = %v; want ErrClosed", err)
	}

	late := &fakeConn{id: 9}
	p.Release("d", late)
	if n := late.closeCount(); n != 1 {
		t.Fatalf("released-after-close conn closed %d times; want 1", n)
	}
}

// TestBarrierReturnOnceAndCursor queues 6 waiters across 3 tenants behind a
// barrier, then releases 4 connections and verifies: each connection is
// delivered to exactly one waiter (return-once), the service order is
// round-robin across tenants with FIFO inside each tenant, and the
// round-robin cursor ends where expected.
func TestBarrierReturnOnceAndCursor(t *testing.T) {
	p := New()

	type ticket struct {
		tenant string
		seq    int
	}
	type outcome struct {
		ticket
		connID int
		err    error
	}
	order := []ticket{{"A", 1}, {"B", 1}, {"C", 1}, {"A", 2}, {"B", 2}, {"C", 2}}

	// Barrier: every waiter must be enqueued (in a known order) before any
	// release happens; waitFor below is the barrier gate.
	outcomes := make(chan outcome, len(order))
	var wg sync.WaitGroup
	queued := 0
	for _, tk := range order {
		tk := tk
		queued++
		want := queued
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := p.Acquire(context.Background(), "d", tk.tenant)
			o := outcome{ticket: tk, err: err}
			if c != nil {
				o.connID = c.(*fakeConn).id
			}
			outcomes <- o
		}()
		waitFor(t, "waiter enqueued", func() bool { return p.waiterCount("d") == want })
	}
	if n := p.waiterCount("d"); n != len(order) {
		t.Fatalf("barrier: %d waiters queued; want %d", n, len(order))
	}

	conns := []*fakeConn{{id: 1}, {id: 2}, {id: 3}, {id: 4}}
	for _, c := range conns {
		p.Release("d", c)
	}

	// Delivery mapping must be A1->1, B1->2, C1->3, A2->4: round-robin
	// across tenants, FIFO inside tenant A, one conn per waiter.
	want := map[ticket]int{{"A", 1}: 1, {"B", 1}: 2, {"C", 1}: 3, {"A", 2}: 4}
	seen := make(map[int]ticket)
	for i := 0; i < len(want); i++ {
		select {
		case o := <-outcomes:
			if o.err != nil {
				t.Fatalf("delivery %d err = %v", i, o.err)
			}
			wantID, ok := want[o.ticket]
			if !ok {
				t.Fatalf("unexpected delivery to %v (conn %d)", o.ticket, o.connID)
			}
			if o.connID != wantID {
				t.Fatalf("%v got conn %d; want conn %d", o.ticket, o.connID, wantID)
			}
			if prev, dup := seen[o.connID]; dup {
				t.Fatalf("conn %d delivered to both %v and %v", o.connID, prev, o.ticket)
			}
			seen[o.connID] = o.ticket
		case <-time.After(2 * time.Second):
			t.Fatalf("delivery %d never happened", i)
		}
	}

	// rr = [A, B, C]; serving A,B,C,A leaves the cursor at index 1 (B).
	if got := p.cursor("d"); got != 1 {
		t.Fatalf("cursor = %d; want 1", got)
	}

	// The remaining two waiters (B2, C2) are still queued; Close wakes them.
	p.Close()
	for i := 0; i < 2; i++ {
		select {
		case o := <-outcomes:
			if !errors.Is(o.err, ErrClosed) {
				t.Fatalf("leftover waiter err = %v; want ErrClosed", o.err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("leftover waiter not woken by Close")
		}
	}
	wg.Wait()
}

func TestSeparateQueuesPerDestination(t *testing.T) {
	p := New()
	w := startAcquire(t, p, context.Background(), "d1", "t", 1)

	// A release for another destination must not reach d1's waiter.
	stray := &fakeConn{id: 1}
	p.Release("d2", stray)
	select {
	case r := <-w:
		t.Fatalf("waiter on d1 got conn from d2: %v", r.conn)
	case <-time.After(50 * time.Millisecond):
	}
	if n := p.idleCount("d2"); n != 1 {
		t.Fatalf("d2 idle = %d; want 1", n)
	}

	c := &fakeConn{id: 2}
	p.Release("d1", c)
	if r := mustAcquire(t, w); r.conn != Conn(c) {
		t.Fatalf("waiter got %v; want c", r.conn)
	}
}
