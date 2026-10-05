// Package pool implements a generic, capacity-bounded object pool.
//
// Semantics:
//   - Borrow reserves a capacity slot before producing; a failed produce
//     releases the reservation (or hands it to a waiter), so slots never leak.
//   - Return cleans (resets) the object first; if cleaning fails the object
//     is destroyed and its slot released.
//   - Once Close is called, returned objects are destroyed instead of being
//     pooled, idle objects are destroyed, and pending waiters are failed.
//   - Waiters can be cancelled via their context.
package pool

import (
	"context"
	"errors"
	"sync"
)

// ErrClosed is returned by Borrow when the pool has been closed.
var ErrClosed = errors.New("pool: closed")

// Pool is a capacity-bounded pool of objects of type T.
//
// produce creates a new object; it is only called after a slot has been
// reserved. reset cleans a returned object before it is reused; a non-nil
// error condemns the object. destroy releases an object's resources; every
// produced object is eventually destroyed exactly once.
type Pool[T any] struct {
	produce func(ctx context.Context) (T, error)
	reset   func(ctx context.Context, obj T) error
	destroy func(obj T)

	mu      sync.Mutex
	idle    []T
	slots   int // reserved capacity: idle + in-use + in-production
	max     int
	closed  bool
	waiters []*waiter[T]
}

type waiter[T any] struct {
	ch   chan handoff[T] // buffered, exactly one send ever
	done bool            // set under mu when fulfilled or cancelled
}

type handoff[T any] struct {
	obj  T
	slot bool // reservation transferred; receiver must produce
	err  error
}

// New creates a pool holding at most max objects.
func New[T any](
	max int,
	produce func(ctx context.Context) (T, error),
	reset func(ctx context.Context, obj T) error,
	destroy func(obj T),
) *Pool[T] {
	if max <= 0 {
		panic("pool: max must be positive")
	}
	return &Pool[T]{
		produce: produce,
		reset:   reset,
		destroy: destroy,
		max:     max,
	}
}

// Borrow acquires an object, producing one if capacity allows. It blocks
// while the pool is exhausted, until an object is returned, a slot frees up,
// the pool closes, or ctx is cancelled.
func (p *Pool[T]) Borrow(ctx context.Context) (T, error) {
	var zero T

	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return zero, ErrClosed
	}
	if n := len(p.idle); n > 0 {
		obj := p.idle[n-1]
		p.idle[n-1] = zero
		p.idle = p.idle[:n-1]
		p.mu.Unlock()
		return obj, nil
	}
	if p.slots < p.max {
		p.slots++
		p.mu.Unlock()
		return p.produceReserved(ctx)
	}
	w := &waiter[T]{ch: make(chan handoff[T], 1)}
	p.waiters = append(p.waiters, w)
	p.mu.Unlock()

	select {
	case h := <-w.ch:
		return p.resolve(h)
	case <-ctx.Done():
		p.mu.Lock()
		if !w.done {
			w.done = true
			p.mu.Unlock()
			return zero, ctx.Err()
		}
		p.mu.Unlock()
		// A handoff was already committed; consume it and put it back.
		h := <-w.ch
		if h.err == nil {
			if h.slot {
				p.releaseSlot()
			} else {
				p.Return(ctx, h.obj)
			}
		}
		return zero, ctx.Err()
	}
}

func (p *Pool[T]) resolve(h handoff[T]) (T, error) {
	var zero T
	if h.err != nil {
		return zero, h.err
	}
	if h.slot {
		return p.produceReserved(context.Background())
	}
	return h.obj, nil
}

// produceReserved produces an object for an already-reserved slot. On
// failure the reservation is released (or transferred to a waiter) so the
// slot cannot leak.
func (p *Pool[T]) produceReserved(ctx context.Context) (T, error) {
	obj, err := p.produce(ctx)
	if err != nil {
		p.releaseSlot()
		var zero T
		return zero, err
	}
	return obj, nil
}

// releaseSlot frees one reserved slot, transferring the reservation to the
// oldest pending waiter when the pool is still open.
func (p *Pool[T]) releaseSlot() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.closed {
		if w := p.popWaiterLocked(); w != nil {
			w.done = true
			w.ch <- handoff[T]{slot: true}
			return
		}
	}
	p.slots--
}

// Return gives an object back to the pool. The object is cleaned first; if
// cleaning fails, or the pool is (or becomes) closed, the object is
// destroyed and its slot released.
func (p *Pool[T]) Return(ctx context.Context, obj T) {
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()

	if !closed {
		if err := p.reset(ctx, obj); err != nil {
			p.destroy(obj)
			p.releaseSlot()
			return
		}
	}

	p.mu.Lock()
	if p.closed {
		p.slots--
		p.mu.Unlock()
		p.destroy(obj)
		return
	}
	if w := p.popWaiterLocked(); w != nil {
		w.done = true
		w.ch <- handoff[T]{obj: obj}
		p.mu.Unlock()
		return
	}
	p.idle = append(p.idle, obj)
	p.mu.Unlock()
}

// Close shuts the pool down. Idle objects are destroyed, pending waiters
// fail with ErrClosed, and objects still on loan are destroyed as they are
// returned. Close is idempotent.
func (p *Pool[T]) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	idle := p.idle
	p.idle = nil
	p.slots -= len(idle)
	for _, w := range p.waiters {
		if !w.done {
			w.done = true
			w.ch <- handoff[T]{err: ErrClosed}
		}
	}
	p.waiters = nil
	p.mu.Unlock()

	for _, obj := range idle {
		p.destroy(obj)
	}
}

// Stats reports the number of idle objects and reserved slots. Reserved
// slots equal idle + in-use + in-production; after Close and the return of
// all loans it converges to zero.
func (p *Pool[T]) Stats() (idle, slots int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.idle), p.slots
}

// popWaiterLocked removes and returns the oldest live waiter, lazily
// discarding cancelled ones. p.mu must be held.
func (p *Pool[T]) popWaiterLocked() *waiter[T] {
	for len(p.waiters) > 0 {
		w := p.waiters[0]
		p.waiters[0] = nil
		p.waiters = p.waiters[1:]
		if !w.done {
			return w
		}
	}
	return nil
}
