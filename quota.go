// Package quota implements a FIFO quota allocator for jobs that need CPU and
// memory at the same time. Allocation is all-or-nothing: a job is never
// granted a partial share of its request. Waiters are served strictly from
// the head of the queue, so a large head request blocks smaller ones behind
// it (head-of-line blocking) instead of letting them overtake.
//
// Cancellation and granting race inside the same mutex: whichever side takes
// the lock first wins. Token release is idempotent; only the first Release
// returns resources to the pool.
package quota

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
)

// Resources is an amount of CPU and memory. Both dimensions must be
// satisfiable for a request to be granted.
type Resources struct {
	CPU int64
	Mem int64
}

func (r Resources) fitsIn(limit Resources) bool {
	return r.CPU <= limit.CPU && r.Mem <= limit.Mem
}

func (r *Resources) add(o Resources) { r.CPU += o.CPU; r.Mem += o.Mem }
func (r *Resources) sub(o Resources) { r.CPU -= o.CPU; r.Mem -= o.Mem }

// ErrOversize is returned when a request can never fit in the pool, even if
// the pool were completely idle.
var ErrOversize = errors.New("quota: request exceeds total capacity")

// ErrNegative is returned for requests with a negative dimension.
var ErrNegative = errors.New("quota: request has negative dimension")

// EventKind classifies entries in the pool's internal event log.
type EventKind int

const (
	EventEnqueue EventKind = iota
	EventGrant
	EventRelease
	EventCancel
)

func (k EventKind) String() string {
	switch k {
	case EventEnqueue:
		return "enqueue"
	case EventGrant:
		return "grant"
	case EventRelease:
		return "release"
	case EventCancel:
		return "cancel"
	}
	return "unknown"
}

// Event is one entry in the pool's event log. Events are appended while
// holding the pool mutex, so their Seq order is a total order consistent
// with every state transition the pool has performed.
type Event struct {
	Seq  int64
	Kind EventKind
	ID   int64     // token/waiter id
	Req  Resources // resources involved
	Used Resources // pool usage after the event
}

// Token represents granted quota. Release returns the quota to the pool and
// is idempotent: concurrent or repeated calls release exactly once.
type Token struct {
	id   int64
	req  Resources
	pool *Pool
	done int32 // atomic CAS guard for idempotent Release
}

// Release returns the granted resources to the pool. Only the first call
// has any effect; later calls (including concurrent ones) are no-ops.
func (t *Token) Release() {
	if atomic.CompareAndSwapInt32(&t.done, 0, 1) {
		t.pool.release(t)
	}
}

// Resources returns the amounts this token was granted for.
func (t *Token) Resources() Resources { return t.req }

type waiterState int

const (
	waiterPending waiterState = iota
	waiterGranted
	waiterCanceled
)

type waiter struct {
	id    int64
	req   Resources
	ch    chan *Token // buffered (cap 1): the granter never blocks
	state waiterState
}

// Pool is a FIFO quota pool with a fixed CPU/memory capacity.
type Pool struct {
	mu       sync.Mutex
	capacity Resources
	used     Resources
	queue    []*waiter
	nextID   int64
	seq      int64
	events   []Event
}

// NewPool creates a pool with the given total capacity.
func NewPool(capacity Resources) *Pool {
	return &Pool{capacity: capacity}
}

// Acquire blocks until req is granted or ctx is done. Requests are granted
// atomically: either both CPU and memory are granted, or neither is. If the
// pool cannot satisfy the request immediately, the caller is appended to a
// FIFO queue and only the head of the queue is reconsidered when resources
// are released.
//
// If ctx is canceled concurrently with a grant, the outcome is decided by
// lock order: if the grant was already committed under the pool mutex,
// Acquire returns the token (and the caller must Release it); otherwise the
// waiter is removed and ctx.Err() is returned.
func (p *Pool) Acquire(ctx context.Context, req Resources) (*Token, error) {
	if req.CPU < 0 || req.Mem < 0 {
		return nil, ErrNegative
	}
	p.mu.Lock()
	if !req.fitsIn(p.capacity) {
		p.mu.Unlock()
		return nil, ErrOversize
	}
	// Fast path: idle queue and the request fits right away. The empty-queue
	// condition is what keeps the FIFO order honest.
	if len(p.queue) == 0 && req.fitsIn(p.availLocked()) {
		tok := p.grantLocked(p.nextID, req)
		p.nextID++
		p.mu.Unlock()
		return tok, nil
	}
	w := &waiter{id: p.nextID, req: req, ch: make(chan *Token, 1)}
	p.nextID++
	p.queue = append(p.queue, w)
	p.logLocked(EventEnqueue, w.id, req)
	p.mu.Unlock()

	select {
	case tok := <-w.ch:
		return tok, nil
	case <-ctx.Done():
		return p.cancel(w, ctx.Err())
	}
}

// cancel resolves a cancellation against a possibly concurrent grant. Both
// sides commit under p.mu, so exactly one of them wins.
func (p *Pool) cancel(w *waiter, err error) (*Token, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if w.state == waiterGranted {
		// The grant was committed first; hand over the token. The caller
		// now owns it and must Release it.
		return <-w.ch, nil
	}
	w.state = waiterCanceled
	for i, q := range p.queue {
		if q == w {
			p.queue = append(p.queue[:i], p.queue[i+1:]...)
			break
		}
	}
	p.logLocked(EventCancel, w.id, w.req)
	return nil, err
}

func (p *Pool) release(t *Token) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.used.sub(t.req)
	p.logLocked(EventRelease, t.id, t.req)
	p.serveLocked()
}

// serveLocked grants waiters strictly from the head of the queue. If the
// head does not fit, nobody behind it is considered: no overtaking, no
// partial allocation.
func (p *Pool) serveLocked() {
	for len(p.queue) > 0 {
		w := p.queue[0]
		if w.state != waiterPending {
			p.queue = p.queue[1:]
			continue
		}
		if !w.req.fitsIn(p.availLocked()) {
			return
		}
		p.queue = p.queue[1:]
		w.state = waiterGranted
		tok := p.grantLocked(w.id, w.req)
		w.ch <- tok
	}
}

// grantLocked commits a grant: it charges usage, mints the token, and logs
// the event, all atomically under p.mu.
func (p *Pool) grantLocked(id int64, req Resources) *Token {
	p.used.add(req)
	p.logLocked(EventGrant, id, req)
	return &Token{id: id, req: req, pool: p}
}

func (p *Pool) availLocked() Resources {
	return Resources{CPU: p.capacity.CPU - p.used.CPU, Mem: p.capacity.Mem - p.used.Mem}
}

func (p *Pool) logLocked(kind EventKind, id int64, req Resources) {
	p.events = append(p.events, Event{
		Seq:  p.seq,
		Kind: kind,
		ID:   id,
		Req:  req,
		Used: p.used,
	})
	p.seq++
}

// Stats reports current usage, capacity, and queue length.
func (p *Pool) Stats() (used, capacity Resources, queued int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.used, p.capacity, len(p.queue)
}

// Events returns a copy of the pool's event log in commit order.
func (p *Pool) Events() []Event {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]Event, len(p.events))
	copy(out, p.events)
	return out
}
