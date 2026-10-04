// Package quota implements a FIFO quota pool where jobs acquire CPU and
// memory atomically (no partial grants), cancellation and grants are
// decided by lock acquisition order, and token release is idempotent.
package quota

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrInvalidRequest is returned when a request is negative or exceeds the
// pool's total capacity, so it could never be satisfied.
var ErrInvalidRequest = errors.New("quota: request is negative or exceeds pool capacity")

// EventKind identifies the type of a linearization event.
type EventKind int

const (
	EventEnqueued EventKind = iota
	EventGranted
	EventCanceled
	EventReleased
)

func (k EventKind) String() string {
	switch k {
	case EventEnqueued:
		return "enqueued"
	case EventGranted:
		return "granted"
	case EventCanceled:
		return "canceled"
	case EventReleased:
		return "released"
	}
	return "unknown"
}

// Event is a state transition recorded while holding the pool lock, so the
// event log is a linearization of all pool operations. UsedCPU/UsedMem are
// snapshots of pool usage immediately after the transition.
type Event struct {
	Seq     uint64
	Kind    EventKind
	ReqID   uint64
	CPU     int64
	Mem     int64
	UsedCPU int64
	UsedMem int64
}

type reqState int

const (
	statePending reqState = iota
	stateGranted
	stateCanceled
)

type request struct {
	id      uint64
	cpu     int64
	mem     int64
	state   reqState
	grantCh chan struct{} // closed exactly once, upon grant
}

// Token represents a granted quota. Release is idempotent.
type Token struct {
	pool     *Pool
	id       uint64
	cpu      int64
	mem      int64
	released bool // guarded by pool.mu
}

// Pool is a combined CPU+memory quota pool with a FIFO wait queue.
type Pool struct {
	mu       sync.Mutex
	totalCPU int64
	totalMem int64
	usedCPU  int64
	usedMem  int64
	queue    []*request
	nextID   uint64
	seq      uint64
	events   []Event
}

// NewPool creates a pool with the given total CPU and memory capacity.
func NewPool(cpu, mem int64) *Pool {
	if cpu < 0 || mem < 0 {
		panic(fmt.Sprintf("quota: negative pool capacity cpu=%d mem=%d", cpu, mem))
	}
	return &Pool{totalCPU: cpu, totalMem: mem}
}

// Acquire blocks until cpu+mem are granted atomically, the request is
// canceled via ctx, or the request is found unsatisfiable. If cancellation
// and a grant race, whichever happens first while holding the pool lock
// wins: a granted request returns a live Token even if ctx is canceled.
func (p *Pool) Acquire(ctx context.Context, cpu, mem int64) (*Token, error) {
	if cpu < 0 || mem < 0 || cpu > p.totalCPU || mem > p.totalMem {
		return nil, ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	p.mu.Lock()
	req := &request{id: p.nextID, cpu: cpu, mem: mem, grantCh: make(chan struct{})}
	p.nextID++
	p.queue = append(p.queue, req)
	p.recordLocked(EventEnqueued, req)
	p.scheduleLocked()
	p.mu.Unlock()

	select {
	case <-req.grantCh:
		return &Token{pool: p, id: req.id, cpu: cpu, mem: mem}, nil
	case <-ctx.Done():
		p.mu.Lock()
		if req.state == statePending {
			// Cancel wins: the request never held resources.
			req.state = stateCanceled
			p.removeLocked(req)
			p.recordLocked(EventCanceled, req)
			p.scheduleLocked()
			p.mu.Unlock()
			return nil, ctx.Err()
		}
		p.mu.Unlock()
		// Grant won the race inside the lock; the token is live and
		// must be released by the caller.
		return &Token{pool: p, id: req.id, cpu: cpu, mem: mem}, nil
	}
}

// scheduleLocked grants the queue head while it fits in the remaining
// capacity. A head that does not fit blocks the whole queue: no partial
// grants and no overtaking.
func (p *Pool) scheduleLocked() {
	for len(p.queue) > 0 {
		head := p.queue[0]
		if head.cpu > p.totalCPU-p.usedCPU || head.mem > p.totalMem-p.usedMem {
			return
		}
		p.usedCPU += head.cpu
		p.usedMem += head.mem
		head.state = stateGranted
		p.queue = p.queue[1:]
		p.recordLocked(EventGranted, head)
		close(head.grantCh)
	}
}

func (p *Pool) removeLocked(req *request) {
	for i, q := range p.queue {
		if q == req {
			p.queue = append(p.queue[:i], p.queue[i+1:]...)
			return
		}
	}
}

func (p *Pool) recordLocked(kind EventKind, req *request) {
	p.events = append(p.events, Event{
		Seq:     p.seq,
		Kind:    kind,
		ReqID:   req.id,
		CPU:     req.cpu,
		Mem:     req.mem,
		UsedCPU: p.usedCPU,
		UsedMem: p.usedMem,
	})
	p.seq++
}

// Release returns the token's quota to the pool. It is idempotent: extra
// calls are no-ops and never double-count the returned resources.
func (t *Token) Release() {
	p := t.pool
	p.mu.Lock()
	if t.released {
		p.mu.Unlock()
		return
	}
	t.released = true
	p.usedCPU -= t.cpu
	p.usedMem -= t.mem
	p.recordLocked(EventReleased, &request{id: t.id, cpu: t.cpu, mem: t.mem})
	p.scheduleLocked()
	p.mu.Unlock()
}

// Used returns the currently granted CPU and memory.
func (p *Pool) Used() (cpu, mem int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.usedCPU, p.usedMem
}

// Events returns a copy of the linearized event log.
func (p *Pool) Events() []Event {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Event(nil), p.events...)
}
