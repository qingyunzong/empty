// Package pool provides a generic, capacity-bounded object pool with
// reset-on-return, destroy-on-close and cancellable waits.
package pool

import (
	"context"
	"errors"
	"sync"
)

// ErrClosed is returned by Get when the pool has been closed.
var ErrClosed = errors.New("pool: closed")

// Config configures a Pool.
//
// Factory creates a new object. It is called without holding any pool lock
// and receives the caller's context.
// Reset cleans an object before it is reused. If Reset returns an error the
// object is destroyed and its capacity slot is released.
// Destroy releases an object permanently. It is called exactly once for
// every object the pool retires.
type Config[T any] struct {
	Factory func(ctx context.Context) (T, error)
	Reset   func(v T) error
	Destroy func(v T)
	Max     int
}

// Pool is a bounded pool of reusable objects. The zero value is not usable;
// construct one with New.
type Pool[T any] struct {
	factory func(ctx context.Context) (T, error)
	reset   func(v T) error
	destroy func(v T)
	max     int

	mu      sync.Mutex
	idle    []T
	live    int // reserved slots: idle + checked out + being created
	closed  bool
	waiters []chan struct{}
}

// New creates a Pool. Max must be positive and Factory must be set.
func New[T any](cfg Config[T]) (*Pool[T], error) {
	if cfg.Max <= 0 {
		return nil, errors.New("pool: Max must be positive")
	}
	if cfg.Factory == nil {
		return nil, errors.New("pool: Factory is required")
	}
	return &Pool[T]{
		factory: cfg.Factory,
		reset:   cfg.Reset,
		destroy: cfg.Destroy,
		max:     cfg.Max,
	}, nil
}

// Get returns an object from the pool, creating one if capacity allows.
// If the pool is at capacity, Get blocks until an object is returned, a slot
// is freed, the pool is closed, or ctx is cancelled.
func (p *Pool[T]) Get(ctx context.Context) (T, error) {
	var zero T
	for {
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			return zero, ErrClosed
		}
		if n := len(p.idle); n > 0 {
			v := p.idle[n-1]
			p.idle[n-1] = zero
			p.idle = p.idle[:n-1]
			p.mu.Unlock()
			return v, nil
		}
		if p.live < p.max {
			p.live++ // reserve a slot before unlocking
			p.mu.Unlock()

			v, err := p.factory(ctx)
			if err != nil {
				// Factory failed: release the reserved slot and wake a
				// waiter so the freed capacity is not leaked.
				p.mu.Lock()
				p.live--
				p.signalLocked()
				p.mu.Unlock()
				return zero, err
			}
			return v, nil
		}
		ch := make(chan struct{}, 1)
		p.waiters = append(p.waiters, ch)
		p.mu.Unlock()

		select {
		case <-ch:
			// Woken: retry from the top.
		case <-ctx.Done():
			p.mu.Lock()
			removed := p.removeWaiterLocked(ch)
			p.mu.Unlock()
			if removed {
				return zero, ctx.Err()
			}
			// Already signalled: loop again so the object or slot that
			// woke us is not stranded.
		}
	}
}

// Put returns an object to the pool. The object is first cleaned with Reset;
// if Reset fails the object is destroyed and its capacity slot released.
// If the pool is closed (including while Reset was running) the object is
// destroyed instead of being pooled.
func (p *Pool[T]) Put(v T) {
	p.mu.Lock()
	if p.closed {
		p.live--
		p.mu.Unlock()
		p.destroyObject(v)
		return
	}
	p.mu.Unlock()

	if p.reset != nil {
		if err := p.reset(v); err != nil {
			p.mu.Lock()
			p.live--
			p.signalLocked()
			p.mu.Unlock()
			p.destroyObject(v)
			return
		}
	}

	p.mu.Lock()
	if p.closed {
		// Closed while resetting: destroy rather than pool.
		p.live--
		p.mu.Unlock()
		p.destroyObject(v)
		return
	}
	p.idle = append(p.idle, v)
	p.signalLocked()
	p.mu.Unlock()
}

// Close marks the pool closed, destroys all idle objects and wakes every
// blocked waiter with ErrClosed. Objects still checked out are destroyed
// when they are Put back. Close is idempotent.
func (p *Pool[T]) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	idle := p.idle
	p.idle = nil
	p.live -= len(idle)
	waiters := p.waiters
	p.waiters = nil
	p.mu.Unlock()

	for _, v := range idle {
		p.destroyObject(v)
	}
	for _, ch := range waiters {
		ch <- struct{}{}
	}
}

// Live reports the number of reserved capacity slots (idle + checked out +
// being created). It is intended for tests and diagnostics.
func (p *Pool[T]) Live() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.live
}

// signalLocked wakes one waiter, if any. The caller must hold p.mu.
func (p *Pool[T]) signalLocked() {
	for len(p.waiters) > 0 {
		ch := p.waiters[0]
		p.waiters[0] = nil
		p.waiters = p.waiters[1:]
		select {
		case ch <- struct{}{}:
			return
		default:
			// Waiter already cancelled and left; try the next one.
		}
	}
}

// removeWaiterLocked removes ch from the waiter queue, reporting whether it
// was still present. The caller must hold p.mu.
func (p *Pool[T]) removeWaiterLocked(ch chan struct{}) bool {
	for i, w := range p.waiters {
		if w == ch {
			copy(p.waiters[i:], p.waiters[i+1:])
			p.waiters[len(p.waiters)-1] = nil
			p.waiters = p.waiters[:len(p.waiters)-1]
			return true
		}
	}
	return false
}

func (p *Pool[T]) destroyObject(v T) {
	if p.destroy != nil {
		p.destroy(v)
	}
}
