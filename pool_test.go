package connpool

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// pending reports how many waiters of tenant are queued for dest.
func (p *Pool) pending(dest, tenant string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	q := p.queues[dest]
	if q == nil {
		return 0
	}
	return len(q.waiters[tenant])
}

// cursor exposes the round-robin cursor of dest's queue for tests.
func (p *Pool) cursor(dest string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	q := p.queues[dest]
	if q == nil {
		return -1
	}
	return q.cursor
}

func waitFor(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", msg)
		}
		time.Sleep(time.Millisecond)
	}
}

type acquisition struct {
	name string
	conn *Conn
	err  error
}

// acquireAsync starts an Acquire and returns a channel for its result.
func acquireAsync(ctx context.Context, p *Pool, dest, tenant, name string) <-chan acquisition {
	ch := make(chan acquisition, 1)
	go func() {
		conn, err := p.Acquire(ctx, dest, tenant)
		ch <- acquisition{name: name, conn: conn, err: err}
	}()
	return ch
}

func mustRelease(t *testing.T, p *Pool, conn *Conn) {
	t.Helper()
	if err := p.Release(conn); err != nil {
		t.Fatalf("Release(%v): %v", conn.Value, err)
	}
}

func TestRoundRobinAcrossTenantsFIFOWithinTenant(t *testing.T) {
	p := New()
	defer p.Close()
	ctx := context.Background()

	// Enqueue in order: A1, B1, A2, C1, B2 (deterministic via pending).
	a1 := acquireAsync(ctx, p, "d", "a", "A1")
	waitFor(t, func() bool { return p.pending("d", "a") == 1 }, "A1 queued")
	b1 := acquireAsync(ctx, p, "d", "b", "B1")
	waitFor(t, func() bool { return p.pending("d", "b") == 1 }, "B1 queued")
	a2 := acquireAsync(ctx, p, "d", "a", "A2")
	waitFor(t, func() bool { return p.pending("d", "a") == 2 }, "A2 queued")
	c1 := acquireAsync(ctx, p, "d", "c", "C1")
	waitFor(t, func() bool { return p.pending("d", "c") == 1 }, "C1 queued")
	b2 := acquireAsync(ctx, p, "d", "b", "B2")
	waitFor(t, func() bool { return p.pending("d", "b") == 2 }, "B2 queued")

	results := make(chan acquisition, 5)
	for _, ch := range []<-chan acquisition{a1, b1, a2, c1, b2} {
		ch := ch
		go func() { results <- <-ch }()
	}

	// Release 5 connections; expected handout order is round-robin across
	// tenants (a, b, c, a, b) and FIFO within each tenant.
	want := []string{"A1", "B1", "C1", "A2", "B2"}
	for i, name := range want {
		mustRelease(t, p, &Conn{Dest: "d", Value: fmt.Sprintf("conn-%d", i)})
		select {
		case got := <-results:
			if got.err != nil {
				t.Fatalf("Acquire %s: %v", got.name, got.err)
			}
			if got.name != name {
				t.Fatalf("handout %d: got %s, want %s", i, got.name, name)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for handout %d (%s)", i, name)
		}
	}
}

func TestRotationCursor(t *testing.T) {
	p := New()
	defer p.Close()
	ctx := context.Background()

	for _, tenant := range []string{"a", "b", "c"} {
		acquireAsync(ctx, p, "d", tenant, tenant)
		waitFor(t, func() bool { return p.pending("d", tenant) == 1 }, tenant+" queued")
	}
	if got := p.cursor("d"); got != 0 {
		t.Fatalf("initial cursor = %d, want 0", got)
	}
	// Each delivery advances the cursor past the served tenant.
	for i, want := range []int{1, 2, 0} {
		mustRelease(t, p, &Conn{Dest: "d"})
		waitFor(t, func() bool { return p.cursor("d") == want }, "cursor advance")
		if got := p.cursor("d"); got != want {
			t.Fatalf("after delivery %d: cursor = %d, want %d", i, got, want)
		}
	}
}

func TestCancelBeforeDelivery(t *testing.T) {
	p := New()
	defer p.Close()

	ctx, cancel := context.WithCancel(context.Background())
	ch := acquireAsync(ctx, p, "d", "a", "A1")
	waitFor(t, func() bool { return p.pending("d", "a") == 1 }, "A1 queued")
	cancel()
	select {
	case got := <-ch:
		if !errors.Is(got.err, context.Canceled) {
			t.Fatalf("got err %v, want context.Canceled", got.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled Acquire did not return")
	}
	waitFor(t, func() bool { return p.pending("d", "a") == 0 }, "waiter removed")

	// The next release must not be swallowed by the cancelled waiter: a
	// later waiter (or the idle list) gets it.
	ok := acquireAsync(context.Background(), p, "d", "a", "A2")
	waitFor(t, func() bool { return p.pending("d", "a") == 1 }, "A2 queued")
	conn := &Conn{Dest: "d"}
	mustRelease(t, p, conn)
	select {
	case got := <-ok:
		if got.err != nil || got.conn != conn {
			t.Fatalf("got %+v, want conn delivered", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("released connection was lost")
	}
}

func TestDeliveredCannotBeCancelled(t *testing.T) {
	p := New()
	defer p.Close()

	ctx, cancel := context.WithCancel(context.Background())
	ch := acquireAsync(ctx, p, "d", "a", "A1")
	waitFor(t, func() bool { return p.pending("d", "a") == 1 }, "A1 queued")

	conn := &Conn{Dest: "d"}
	mustRelease(t, p, conn) // delivery wins the lock here
	cancel()                // cancellation loses: already delivered

	select {
	case got := <-ch:
		if got.err != nil || got.conn != conn {
			t.Fatalf("got %+v, want delivered conn despite cancel", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("delivered Acquire did not return")
	}
}

func TestCloseWakesWaitersAndRejectsNew(t *testing.T) {
	p := New()

	ctx := context.Background()
	a := acquireAsync(ctx, p, "d", "a", "A1")
	b := acquireAsync(ctx, p, "d", "b", "B1")
	waitFor(t, func() bool {
		return p.pending("d", "a") == 1 && p.pending("d", "b") == 1
	}, "waiters queued")

	p.Close()
	for _, ch := range []<-chan acquisition{a, b} {
		select {
		case got := <-ch:
			if !errors.Is(got.err, ErrClosed) {
				t.Fatalf("waiter got err %v, want ErrClosed", got.err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("Close did not wake waiter")
		}
	}
	if _, err := p.Acquire(ctx, "d", "a"); !errors.Is(err, ErrClosed) {
		t.Fatalf("Acquire after Close: got %v, want ErrClosed", err)
	}

	// Release after Close drops the connection but still counts as the
	// single legal return.
	conn := &Conn{Dest: "d"}
	if err := p.Release(conn); err != nil {
		t.Fatalf("Release after Close: %v", err)
	}
	if err := p.Release(conn); !errors.Is(err, ErrDoubleRelease) {
		t.Fatalf("second Release after Close: got %v, want ErrDoubleRelease", err)
	}
}

func TestDoubleRelease(t *testing.T) {
	p := New()
	defer p.Close()

	conn := &Conn{Dest: "d"}
	if err := p.Release(conn); err != nil {
		t.Fatalf("first Release: %v", err)
	}
	if err := p.Release(conn); !errors.Is(err, ErrDoubleRelease) {
		t.Fatalf("second Release: got %v, want ErrDoubleRelease", err)
	}
	// Re-acquiring resets the state: it can be released exactly once more.
	got, err := p.Acquire(context.Background(), "d", "a")
	if err != nil || got != conn {
		t.Fatalf("re-Acquire: %v %v", got, err)
	}
	if err := p.Release(conn); err != nil {
		t.Fatalf("Release after re-Acquire: %v", err)
	}
}

func TestPerDestinationIsolation(t *testing.T) {
	p := New()
	defer p.Close()

	x := acquireAsync(context.Background(), p, "x", "a", "X")
	waitFor(t, func() bool { return p.pending("x", "a") == 1 }, "waiter on x")

	// A connection for dest y must not satisfy a waiter on dest x.
	mustRelease(t, p, &Conn{Dest: "y"})
	select {
	case got := <-x:
		t.Fatalf("waiter on x received %+v from dest y", got)
	case <-time.After(50 * time.Millisecond):
	}
	if got, err := p.Acquire(context.Background(), "y", "a"); err != nil {
		t.Fatalf("Acquire on y: %v (conn %v)", err, got)
	}
}

// TestBarrierExactlyOnce uses a start barrier to race many goroutines through
// Acquire/Release and asserts every connection is held by at most one client
// at any time (each release is handed out exactly once).
func TestBarrierExactlyOnce(t *testing.T) {
	p := New()
	defer p.Close()

	const numConns = 4
	const numClients = 32
	const rounds = 50

	held := make(map[*Conn]*int32, numConns)
	for i := 0; i < numConns; i++ {
		conn := &Conn{Dest: "d", Value: i}
		var n int32
		held[conn] = &n
		mustRelease(t, p, conn)
	}

	var wg sync.WaitGroup
	start := make(chan struct{}) // barrier
	errs := make(chan error, numClients)
	tenants := []string{"t0", "t1", "t2", "t3"}
	for i := 0; i < numClients; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start // wait at the barrier
			tenant := tenants[i%len(tenants)]
			for r := 0; r < rounds; r++ {
				conn, err := p.Acquire(context.Background(), "d", tenant)
				if err != nil {
					errs <- err
					return
				}
				if n := atomic.AddInt32(held[conn], 1); n != 1 {
					errs <- fmt.Errorf("conn %v held by %d clients", conn.Value, n)
					return
				}
				atomic.AddInt32(held[conn], -1)
				if err := p.Release(conn); err != nil {
					errs <- err
					return
				}
			}
		}(i)
	}
	close(start) // release the barrier
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	// All connections must be back in the idle list.
	p.mu.Lock()
	defer p.mu.Unlock()
	if got := len(p.idle["d"]); got != numConns {
		t.Fatalf("idle conns = %d, want %d", got, numConns)
	}
}
