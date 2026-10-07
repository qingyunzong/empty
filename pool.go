// Package connpool implements a client connection pool that queues waiters
// per destination, hands out released connections round-robin across tenants
// and FIFO within a tenant, resolves cancel/delivery races by lock order,
// and rejects new requests once closed.
package connpool

import (
	"context"
	"errors"
	"sync"
)

var (
	// ErrClosed is returned by Acquire after the pool has been closed, and
	// delivered to every waiter woken by Close.
	ErrClosed = errors.New("connpool: pool is closed")
	// ErrDoubleRelease is returned when a connection is released more than
	// once without being re-acquired in between.
	ErrDoubleRelease = errors.New("connpool: connection released twice")
)

// Conn is a pooled connection. Value carries the user payload; Dest selects
// the destination queue the connection belongs to.
type Conn struct {
	Dest  string
	Value any

	idle bool // guarded by Pool.mu
}

type result struct {
	conn *Conn
	err  error
}

// waiter is one queued Acquire call. ch is buffered with capacity 1 so
// delivery (under the pool lock) never blocks. done is set under the lock
// exactly once, by whichever of delivery, cancellation, or Close wins the
// lock first.
type waiter struct {
	ch   chan result
	done bool
}

// destQueue holds the waiters for one destination. order lists tenants in
// first-seen order and never shrinks; cursor is the round-robin start index
// into order and advances past the tenant that received the last delivery.
type destQueue struct {
	order   []string
	waiters map[string][]*waiter // tenant -> FIFO queue
	cursor  int
}

// next pops the head waiter of the first non-empty tenant found by scanning
// order starting at cursor, and advances the cursor past that tenant.
func (q *destQueue) next() *waiter {
	n := len(q.order)
	for i := 0; i < n; i++ {
		idx := (q.cursor + i) % n
		if ws := q.waiters[q.order[idx]]; len(ws) > 0 {
			w := ws[0]
			q.waiters[q.order[idx]] = ws[1:]
			q.cursor = (idx + 1) % n
			return w
		}
	}
	return nil
}

func (q *destQueue) remove(tenant string, w *waiter) {
	ws := q.waiters[tenant]
	for i, x := range ws {
		if x == w {
			q.waiters[tenant] = append(ws[:i], ws[i+1:]...)
			return
		}
	}
}

// Pool is a connection pool. The zero value is not usable; call New.
type Pool struct {
	mu     sync.Mutex
	idle   map[string][]*Conn // dest -> idle connections
	queues map[string]*destQueue
	closed bool
}

// New returns an empty, open pool.
func New() *Pool {
	return &Pool{
		idle:   make(map[string][]*Conn),
		queues: make(map[string]*destQueue),
	}
}

// Acquire returns a connection for dest, blocking until one is released, the
// context is cancelled, or the pool is closed. tenant identifies the caller
// for round-robin fairness. If cancellation and delivery race, whichever
// takes the pool lock first wins: a delivered connection is never cancelled.
func (p *Pool) Acquire(ctx context.Context, dest, tenant string) (*Conn, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, ErrClosed
	}
	if conns := p.idle[dest]; len(conns) > 0 {
		conn := conns[len(conns)-1]
		p.idle[dest] = conns[:len(conns)-1]
		conn.idle = false
		p.mu.Unlock()
		return conn, nil
	}
	q := p.queues[dest]
	if q == nil {
		q = &destQueue{waiters: make(map[string][]*waiter)}
		p.queues[dest] = q
	}
	if _, ok := q.waiters[tenant]; !ok {
		q.order = append(q.order, tenant)
	}
	w := &waiter{ch: make(chan result, 1)}
	q.waiters[tenant] = append(q.waiters[tenant], w)
	p.mu.Unlock()

	select {
	case res := <-w.ch:
		return res.conn, res.err
	case <-ctx.Done():
		p.mu.Lock()
		if w.done {
			// Delivery or Close won the lock first; the result is
			// already buffered in ch. A delivered connection cannot
			// be cancelled.
			res := <-w.ch
			p.mu.Unlock()
			return res.conn, res.err
		}
		w.done = true
		p.queues[dest].remove(tenant, w)
		p.mu.Unlock()
		return nil, ctx.Err()
	}
}

// Release returns conn to the pool. If waiters are queued for conn.Dest, the
// connection is handed directly to the next waiter chosen round-robin across
// tenants and FIFO within a tenant; otherwise it goes back to the idle list.
// Releasing the same connection twice returns ErrDoubleRelease. After Close,
// released connections are dropped.
func (p *Pool) Release(conn *Conn) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if conn.idle {
		return ErrDoubleRelease
	}
	if p.closed {
		conn.idle = true // dropped, but the single legal return is consumed
		return nil
	}
	if q := p.queues[conn.Dest]; q != nil {
		if w := q.next(); w != nil {
			conn.idle = false
			w.done = true
			w.ch <- result{conn: conn}
			return nil
		}
	}
	conn.idle = true
	p.idle[conn.Dest] = append(p.idle[conn.Dest], conn)
	return nil
}

// Close marks the pool closed, wakes every queued waiter with ErrClosed, and
// drops idle connections. Subsequent Acquire calls fail with ErrClosed.
func (p *Pool) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	p.closed = true
	for _, q := range p.queues {
		for _, tenant := range q.order {
			for _, w := range q.waiters[tenant] {
				w.done = true
				w.ch <- result{err: ErrClosed}
			}
			q.waiters[tenant] = nil
		}
	}
	p.queues = make(map[string]*destQueue)
	p.idle = make(map[string][]*Conn)
}
