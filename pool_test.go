package dialpool

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeConn is a test connection tracking whether it was closed.
type fakeConn struct {
	id     int
	closed atomic.Int32
}

func (c *fakeConn) Close() error {
	c.closed.Add(1)
	return nil
}

func (c *fakeConn) isClosed() bool { return c.closed.Load() > 0 }

// scriptDialer is a controllable dialer. Each queued behavior describes how
// one Dial call behaves: succeed immediately, fail, or block on a gate
// channel until the test releases it (used to simulate a slow/late dial).
type scriptDialer struct {
	mu        sync.Mutex
	behaviors []behavior
	calls     int
	inFlight  atomic.Int32
	maxFlight atomic.Int32
}

type behavior struct {
	conn Conn
	err  error
	gate chan struct{} // if non-nil, Dial blocks until the gate is closed
}

func (d *scriptDialer) dial(ctx context.Context) (Conn, error) {
	d.mu.Lock()
	i := d.calls
	d.calls++
	d.mu.Unlock()
	if i >= len(d.behaviors) {
		return nil, errors.New("scriptDialer: unexpected extra dial")
	}
	cur := d.inFlight.Add(1)
	for {
		old := d.maxFlight.Load()
		if cur <= old || d.maxFlight.CompareAndSwap(old, cur) {
			break
		}
	}
	defer d.inFlight.Add(-1)
	b := d.behaviors[i]
	if b.gate != nil {
		select {
		case <-b.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return b.conn, b.err
}

func (d *scriptDialer) callCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls
}

func shortCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 50*time.Millisecond)
}

// TestSuccessUniqueDelivery: several concurrent waiters each receive a
// distinct connection; no connection is delivered twice.
func TestSuccessUniqueDelivery(t *testing.T) {
	d := &scriptDialer{behaviors: []behavior{
		{conn: &fakeConn{id: 1}},
		{conn: &fakeConn{id: 2}},
		{conn: &fakeConn{id: 3}},
	}}
	p := New(3, d.dial)
	defer p.Close()

	const waiters = 3
	got := make(chan Conn, waiters)
	var wg sync.WaitGroup
	for i := 0; i < waiters; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := p.Get(context.Background())
			if err != nil {
				t.Errorf("Get: %v", err)
				return
			}
			got <- c
		}()
	}
	wg.Wait()
	close(got)

	seen := map[int]bool{}
	for c := range got {
		fc := c.(*fakeConn)
		if seen[fc.id] {
			t.Fatalf("connection %d delivered more than once", fc.id)
		}
		seen[fc.id] = true
	}
	if len(seen) != waiters {
		t.Fatalf("expected %d unique connections, got %d", waiters, len(seen))
	}
	if d.callCount() != waiters {
		t.Fatalf("expected %d dials, got %d", waiters, d.callCount())
	}
}

// TestCapacityEnforced: with capacity C, at most C dials run concurrently
// and further waiters block until the pool is closed.
func TestCapacityEnforced(t *testing.T) {
	gate := make(chan struct{})
	d := &scriptDialer{behaviors: []behavior{
		{conn: &fakeConn{id: 1}, gate: gate},
		{conn: &fakeConn{id: 2}, gate: gate},
	}}
	p := New(2, d.dial)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	const waiters = 5
	errs := make(chan error, waiters)
	for i := 0; i < waiters; i++ {
		go func() {
			c, err := p.Get(ctx)
			if err == nil {
				c.Close()
			}
			errs <- err
		}()
	}

	// Let the two reservable slots start dialing.
	deadline := time.Now().Add(time.Second)
	for d.callCount() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	// Give extra waiters a chance to (incorrectly) start more dials.
	time.Sleep(50 * time.Millisecond)
	if n := d.callCount(); n != 2 {
		t.Fatalf("capacity 2 but %d dials started", n)
	}
	if m := d.maxFlight.Load(); m > 2 {
		t.Fatalf("max concurrent dials %d exceeds capacity 2", m)
	}

	// Close the pool: in-flight waiters fail, late results are destroyed.
	p.Close()
	close(gate)
	var closedErrs, timeoutErrs int
	for i := 0; i < waiters; i++ {
		err := <-errs
		switch {
		case errors.Is(err, ErrClosed):
			closedErrs++
		case errors.Is(err, context.DeadlineExceeded):
			timeoutErrs++
		default:
			t.Fatalf("unexpected Get error: %v", err)
		}
	}
	if closedErrs+timeoutErrs != waiters {
		t.Fatalf("expected all waiters to fail, closed=%d timeout=%d", closedErrs, timeoutErrs)
	}
}

// TestLateConnAfterTimeoutReturnsToPool: a waiter times out while its dial
// is still in flight; the late connection must be parked in the pool and
// handed to a later waiter, never to the expired ticket.
func TestLateConnAfterTimeoutReturnsToPool(t *testing.T) {
	gate := make(chan struct{})
	late := &fakeConn{id: 42}
	d := &scriptDialer{behaviors: []behavior{{conn: late, gate: gate}}}
	p := New(1, d.dial)
	defer p.Close()

	ctx, cancel := shortCtx()
	defer cancel()
	if _, err := p.Get(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", err)
	}

	// Release the dial; the connection arrives after the ticket expired.
	close(gate)
	deadline := time.Now().Add(time.Second)
	for p.Len() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if p.Len() != 1 {
		t.Fatalf("late connection was not returned to the pool, idle=%d", p.Len())
	}
	if late.isClosed() {
		t.Fatal("late connection destroyed instead of being pooled")
	}

	// A later waiter receives exactly that connection (unique delivery).
	c, err := p.Get(context.Background())
	if err != nil {
		t.Fatalf("Get after late arrival: %v", err)
	}
	if c.(*fakeConn).id != 42 {
		t.Fatalf("expected late connection id 42, got %d", c.(*fakeConn).id)
	}
	if d.callCount() != 1 {
		t.Fatalf("expected exactly 1 dial, got %d", d.callCount())
	}
}

// TestLateConnAfterCloseDestroyed: a dial that completes after Close must
// have its connection destroyed, not pooled or delivered.
func TestLateConnAfterCloseDestroyed(t *testing.T) {
	gate := make(chan struct{})
	late := &fakeConn{id: 7}
	d := &scriptDialer{behaviors: []behavior{{conn: late, gate: gate}}}
	p := New(1, d.dial)

	getDone := make(chan error, 1)
	go func() {
		c, err := p.Get(context.Background())
		if err == nil {
			c.Close()
		}
		getDone <- err
	}()

	deadline := time.Now().Add(time.Second)
	for d.callCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := <-getDone; !errors.Is(err, ErrClosed) {
		t.Fatalf("expected ErrClosed for pending waiter, got %v", err)
	}

	// The dial finishes late, after Close.
	close(gate)
	deadline = time.Now().Add(time.Second)
	for !late.isClosed() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !late.isClosed() {
		t.Fatal("late connection after Close was not destroyed")
	}
	if p.Len() != 0 {
		t.Fatalf("closed pool holds %d idle connections", p.Len())
	}
	if _, err := p.Get(context.Background()); !errors.Is(err, ErrClosed) {
		t.Fatalf("Get on closed pool: expected ErrClosed, got %v", err)
	}
}

// TestCloseDestroysIdle: Close destroys connections already parked idle.
func TestCloseDestroysIdle(t *testing.T) {
	gate := make(chan struct{})
	c1 := &fakeConn{id: 1}
	d := &scriptDialer{behaviors: []behavior{{conn: c1, gate: gate}}}
	p := New(1, d.dial)

	ctx, cancel := shortCtx()
	defer cancel()
	if _, err := p.Get(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", err)
	}
	close(gate)
	deadline := time.Now().Add(time.Second)
	for p.Len() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}

	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !c1.isClosed() {
		t.Fatal("idle connection not destroyed on Close")
	}
	if p.Len() != 0 {
		t.Fatalf("closed pool holds %d idle connections", p.Len())
	}
}

// TestDialErrorReleasesSlot: a failed dial delivers the error to the waiter
// and releases the reserved slot so a later Get can dial again.
func TestDialErrorReleasesSlot(t *testing.T) {
	dialErr := errors.New("boom")
	d := &scriptDialer{behaviors: []behavior{
		{err: dialErr},
		{conn: &fakeConn{id: 9}},
	}}
	p := New(1, d.dial)
	defer p.Close()

	if _, err := p.Get(context.Background()); !errors.Is(err, dialErr) {
		t.Fatalf("expected dial error, got %v", err)
	}
	c, err := p.Get(context.Background())
	if err != nil {
		t.Fatalf("second Get after released slot: %v", err)
	}
	if c.(*fakeConn).id != 9 {
		t.Fatalf("expected connection id 9, got %d", c.(*fakeConn).id)
	}
	if d.callCount() != 2 {
		t.Fatalf("expected 2 dials, got %d", d.callCount())
	}
}

// TestDialErrorAfterTimeout: a dial that fails after its ticket expired
// releases the slot without parking anything.
func TestDialErrorAfterTimeout(t *testing.T) {
	gate := make(chan struct{})
	dialErr := errors.New("late boom")
	d := &scriptDialer{behaviors: []behavior{
		{err: dialErr, gate: gate},
		{conn: &fakeConn{id: 5}},
	}}
	p := New(1, d.dial)
	defer p.Close()

	ctx, cancel := shortCtx()
	defer cancel()
	if _, err := p.Get(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", err)
	}
	close(gate)

	// Slot must have been released: the next Get dials again and succeeds.
	c, err := p.Get(context.Background())
	if err != nil {
		t.Fatalf("Get after late dial error: %v", err)
	}
	if c.(*fakeConn).id != 5 {
		t.Fatalf("expected connection id 5, got %d", c.(*fakeConn).id)
	}
	if p.Len() != 0 {
		t.Fatalf("failed late dial left %d idle connections", p.Len())
	}
}
