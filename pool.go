// Package dialpool implements a bounded connection pool that reserves a
// slot before dialing asynchronously. Late connections produced after a
// waiter's deadline are returned to the pool or destroyed, never delivered
// to an expired ticket; after Close every late result is destroyed.
package dialpool

import (
	"context"
	"errors"
	"sync"
)

// ErrClosed is returned by Get after the pool has been closed.
var ErrClosed = errors.New("dialpool: pool is closed")

// Conn is a pooled connection. The pool only needs to be able to close it.
type Conn interface {
	Close() error
}

// DialFunc creates a new connection. It is always invoked on its own
// goroutine with a background context: cancellation of a waiter's context
// never cancels an in-flight dial, so a dial may finish late.
type DialFunc func(ctx context.Context) (Conn, error)

// Pool is a bounded pool of connections.
type Pool struct {
	dial DialFunc
	cap  int

	mu      sync.Mutex
	idle    []Conn
	slots   int                  // reserved slots: dialing + idle + checked out
	pending map[*ticket]struct{} // tickets whose dial is still in flight
	closed  bool
	notify  chan struct{}
}

// New returns a pool that keeps at most capacity connections alive or in
// flight at any moment.
func New(capacity int, dial DialFunc) *Pool {
	if capacity <= 0 {
		panic("dialpool: capacity must be positive")
	}
	if dial == nil {
		panic("dialpool: dial func must not be nil")
	}
	return &Pool{
		dial:    dial,
		cap:     capacity,
		pending: make(map[*ticket]struct{}),
		notify:  make(chan struct{}),
	}
}

// ticket tracks one reserved slot whose dial is in flight. Exactly one of
// done (result delivered to the waiter) or expired (waiter gave up) is set,
// under Pool.mu, so a connection is delivered at most once.
type ticket struct {
	ch      chan dialResult
	done    bool
	expired bool
}

type dialResult struct {
	conn Conn
	err  error
}

// Get returns a connection, an idle one if available, otherwise a freshly
// dialed one. It blocks until a connection is available, ctx is done, or
// the pool is closed.
func (p *Pool) Get(ctx context.Context) (Conn, error) {
	for {
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return nil, ErrClosed
		}
		if n := len(p.idle); n > 0 {
			c := p.idle[n-1]
			p.idle = p.idle[:n-1]
			p.mu.Unlock()
			return c, nil
		}
		if p.slots < p.cap {
			// Reserve the slot first, then create the connection
			// asynchronously so Get never holds the lock while dialing.
			p.slots++
			t := &ticket{ch: make(chan dialResult, 1)}
			p.pending[t] = struct{}{}
			p.mu.Unlock()
			go p.dialAsync(t)
			return p.waitTicket(ctx, t)
		}
		ch := p.notify
		p.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// waitTicket waits for the asynchronous dial bound to t. If ctx expires
// first, the ticket is marked expired unless the result already landed;
// an expired ticket can never receive its connection afterwards.
func (p *Pool) waitTicket(ctx context.Context, t *ticket) (Conn, error) {
	select {
	case res := <-t.ch:
		return res.conn, res.err
	case <-ctx.Done():
	}
	p.mu.Lock()
	if t.done {
		// The dial completed before we gave up; the result is ours.
		p.mu.Unlock()
		res := <-t.ch
		return res.conn, res.err
	}
	t.expired = true
	p.mu.Unlock()
	return nil, ctx.Err()
}

// dialAsync runs the dial and routes the late result: to the waiter if the
// ticket is still valid, into the idle list if the ticket expired, or to
// Close if the pool is closed or the dial failed after expiry.
func (p *Pool) dialAsync(t *ticket) {
	c, err := p.dial(context.Background())

	p.mu.Lock()
	delete(p.pending, t)
	if p.closed {
		p.slots--
		p.mu.Unlock()
		if c != nil {
			c.Close()
		}
		p.broadcast()
		return
	}
	if t.expired {
		if err == nil && c != nil {
			p.idle = append(p.idle, c)
		} else {
			p.slots--
		}
		p.mu.Unlock()
		p.broadcast()
		return
	}
	t.done = true
	if err != nil {
		p.slots--
	}
	p.mu.Unlock()
	t.ch <- dialResult{conn: c, err: err}
	p.broadcast()
}

// Close marks the pool closed, wakes all waiters with ErrClosed, and
// destroys every idle connection. Late dial results are destroyed as they
// arrive.
func (p *Pool) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	idle := p.idle
	p.idle = nil
	p.slots -= len(idle)
	// Fail every waiter still blocked on an in-flight dial; the late
	// results themselves are destroyed by dialAsync as they arrive.
	for t := range p.pending {
		if !t.done && !t.expired {
			t.done = true
			t.ch <- dialResult{err: ErrClosed}
		}
	}
	p.broadcastLocked()
	p.mu.Unlock()
	for _, c := range idle {
		c.Close()
	}
	return nil
}

// Len reports the number of idle connections currently held by the pool.
func (p *Pool) Len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.idle)
}

func (p *Pool) broadcast() {
	p.mu.Lock()
	p.broadcastLocked()
	p.mu.Unlock()
}

func (p *Pool) broadcastLocked() {
	close(p.notify)
	p.notify = make(chan struct{})
}
