// Package connpool implements a client connection pool.
//
// Waiters queue per destination. Every release hands the connection to a
// waiter chosen by round-robin across tenants and FIFO inside each tenant.
// Cancellation and delivery race under one mutex: whichever happens first
// while holding the lock wins, and a delivered connection can no longer be
// cancelled. Close rejects new requests and wakes all waiters.
package connpool

import (
	"context"
	"errors"
	"io"
	"sync"
)

// ErrClosed is returned by Acquire after the pool has been closed, and is
// delivered to every waiter still queued when Close is called.
var ErrClosed = errors.New("connpool: pool is closed")

// Conn is a pooled client connection.
type Conn = io.Closer

type result struct {
	conn Conn
	err  error
}

// waiter is one pending Acquire. ch is buffered with capacity 1 so the
// pool never blocks while holding the lock; exactly one result is ever
// sent, decided by the done/delivered flags under the pool mutex.
type waiter struct {
	ch        chan result
	done      bool // resolved: delivered, cancelled, or closed
	delivered bool // a connection was assigned before resolution
}

type tenantQueue struct {
	waiters []*waiter
}

// destState holds the idle connections and the tenant queues of one
// destination. rr lists tenants that have (or had) waiters, in first
// arrival order; cursor is the round-robin cursor into rr.
type destState struct {
	idle    []Conn
	rr      []string
	tenants map[string]*tenantQueue
	cursor  int
}

func newDestState() *destState {
	return &destState{tenants: make(map[string]*tenantQueue)}
}

// nextWaiter picks the next waiter in round-robin order across tenants and
// FIFO inside each tenant, starting at the cursor. Cancelled waiters are
// pruned lazily from the head of each tenant queue. On success the cursor
// advances to the tenant after the one served.
func (ds *destState) nextWaiter() *waiter {
	n := len(ds.rr)
	for i := 0; i < n; i++ {
		idx := (ds.cursor + i) % n
		tq := ds.tenants[ds.rr[idx]]
		for len(tq.waiters) > 0 && tq.waiters[0].done {
			tq.waiters = tq.waiters[1:]
		}
		if len(tq.waiters) == 0 {
			continue
		}
		w := tq.waiters[0]
		tq.waiters = tq.waiters[1:]
		ds.cursor = (idx + 1) % n
		return w
	}
	return nil
}

// Pool is a connection pool keyed by destination.
type Pool struct {
	mu     sync.Mutex
	closed bool
	dests  map[string]*destState
}

// New returns an empty Pool.
func New() *Pool {
	return &Pool{dests: make(map[string]*destState)}
}

// Acquire returns a connection for dest on behalf of tenant, blocking until
// one is released, ctx is done, or the pool is closed. If a connection is
// delivered before ctx fires (decided under the pool lock), Acquire returns
// that connection and the cancellation is ignored.
func (p *Pool) Acquire(ctx context.Context, dest, tenant string) (Conn, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, ErrClosed
	}
	ds := p.dests[dest]
	if ds == nil {
		ds = newDestState()
		p.dests[dest] = ds
	}
	if n := len(ds.idle); n > 0 {
		c := ds.idle[n-1]
		ds.idle = ds.idle[:n-1]
		p.mu.Unlock()
		return c, nil
	}
	w := &waiter{ch: make(chan result, 1)}
	tq := ds.tenants[tenant]
	if tq == nil {
		tq = &tenantQueue{}
		ds.tenants[tenant] = tq
		ds.rr = append(ds.rr, tenant)
	}
	tq.waiters = append(tq.waiters, w)
	p.mu.Unlock()

	select {
	case r := <-w.ch:
		return r.conn, r.err
	case <-ctx.Done():
		p.mu.Lock()
		if w.done {
			p.mu.Unlock()
			if w.delivered {
				// Delivery won the race under the lock; the
				// connection is already buffered in w.ch.
				r := <-w.ch
				return r.conn, nil
			}
			return nil, ctx.Err()
		}
		w.done = true
		p.mu.Unlock()
		return nil, ctx.Err()
	}
}

// Release returns c to the pool. If a waiter is queued for dest, c is
// handed to exactly one waiter chosen by tenant round-robin and intra-tenant
// FIFO; otherwise c becomes idle. After Close, c is closed instead.
func (p *Pool) Release(dest string, c Conn) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		c.Close()
		return
	}
	ds := p.dests[dest]
	if ds == nil {
		ds = newDestState()
		p.dests[dest] = ds
	}
	if w := ds.nextWaiter(); w != nil {
		w.done = true
		w.delivered = true
		w.ch <- result{conn: c}
		p.mu.Unlock()
		return
	}
	ds.idle = append(ds.idle, c)
	p.mu.Unlock()
}

// Close marks the pool closed, wakes every queued waiter with ErrClosed,
// and closes all idle connections. Later Acquire calls fail with ErrClosed
// and later Release calls close the released connection.
func (p *Pool) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	for _, ds := range p.dests {
		for _, tq := range ds.tenants {
			for _, w := range tq.waiters {
				if !w.done {
					w.done = true
					w.ch <- result{err: ErrClosed}
				}
			}
			tq.waiters = nil
		}
		for _, c := range ds.idle {
			c.Close()
		}
		ds.idle = nil
	}
	p.mu.Unlock()
}
