// Package statewait provides a version barrier: callers wait until the
// observed version becomes greater than a value they specify.
package statewait

import (
	"context"
	"errors"
	"sync"
)

// ErrClosed is returned by Wait after the Barrier has been closed.
var ErrClosed = errors.New("statewait: barrier closed")

// Barrier lets goroutines wait for a monotonically increasing version.
// The zero value is ready to use.
type Barrier struct {
	mu      sync.Mutex
	version uint64
	notify  chan struct{} // closed when version advances; replaced under mu
	done    chan struct{} // closed once on Close
	closed  bool
}

// init lazily allocates channels so the zero value is usable.
// Callers must hold b.mu.
func (b *Barrier) init() {
	if b.notify == nil {
		b.notify = make(chan struct{})
		b.done = make(chan struct{})
	}
}

// New returns a ready-to-use Barrier.
func New() *Barrier {
	return &Barrier{
		notify: make(chan struct{}),
		done:   make(chan struct{}),
	}
}

// Version reports the current version.
func (b *Barrier) Version() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.version
}

// Update advances the barrier version to v and wakes every waiter whose
// threshold is below v. Updating to a version less than or equal to the
// current one is a no-op and wakes nobody.
func (b *Barrier) Update(v uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.init()
	if v <= b.version {
		return
	}
	b.version = v
	close(b.notify)
	b.notify = make(chan struct{})
}

// Wait blocks until the barrier version is greater than v, ctx is done,
// or the barrier is closed — whichever happens first. It returns the
// current version and nil on success, ctx.Err() on cancellation, and
// ErrClosed after Close.
func (b *Barrier) Wait(ctx context.Context, v uint64) (uint64, error) {
	for {
		b.mu.Lock()
		b.init()
		if b.closed {
			ver := b.version
			b.mu.Unlock()
			return ver, ErrClosed
		}
		if b.version > v {
			ver := b.version
			b.mu.Unlock()
			return ver, nil
		}
		// Registration is atomic with respect to Update: the notify
		// channel captured here is guaranteed to be closed by any
		// later Update.
		notify := b.notify
		done := b.done
		b.mu.Unlock()

		select {
		case <-notify:
			// Any advance broadcasts to all waiters; loop to
			// re-check whether our threshold was crossed.
		case <-ctx.Done():
			return b.Version(), ctx.Err()
		case <-done:
			return b.Version(), ErrClosed
		}
	}
}

// Close wakes all current and future waiters with ErrClosed.
func (b *Barrier) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.init()
	if b.closed {
		return
	}
	b.closed = true
	close(b.done)
}
