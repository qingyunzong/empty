// Package locklib provides a cancellable read-write mutex that supports
// downgrading an exclusive hold to a shared hold.
package locklib

import (
	"context"
	"errors"
	"sync"
)

// ErrNotHeld is returned when a release or downgrade is attempted without a
// matching hold. The lock state is left unchanged.
var ErrNotHeld = errors.New("locklib: lock not held")

type waiterKind int

const (
	kindRead waiterKind = iota
	kindWrite
)

type waiter struct {
	kind     waiterKind
	ch       chan struct{} // closed when granted
	granted  bool
	canceled bool
}

// RWLock is a writer-preferring read-write lock with context-cancellable
// acquisition and exclusive-to-shared downgrade.
type RWLock struct {
	mu      sync.Mutex
	writer  bool // an exclusive hold is active
	readers int  // number of active shared holds
	queue   []*waiter
}

// NewRWLock returns a ready-to-use RWLock.
func NewRWLock() *RWLock { return &RWLock{} }

// Lock acquires the exclusive hold, blocking until it is granted or ctx is
// done. If ctx is canceled while queued, the waiter is removed and queued
// waiters behind it are reconsidered immediately.
func (l *RWLock) Lock(ctx context.Context) error {
	l.mu.Lock()
	if !l.writer && l.readers == 0 && len(l.queue) == 0 {
		l.writer = true
		l.mu.Unlock()
		return nil
	}
	w := &waiter{kind: kindWrite, ch: make(chan struct{})}
	l.queue = append(l.queue, w)
	l.mu.Unlock()

	select {
	case <-w.ch:
		return nil
	case <-ctx.Done():
		return l.abortWait(w, ctx)
	}
}

// RLock acquires a shared hold. Readers queued behind a writer never
// overtake it; readers ahead of all queued writers are granted as a batch.
func (l *RWLock) RLock(ctx context.Context) error {
	l.mu.Lock()
	if !l.writer && len(l.queue) == 0 {
		l.readers++
		l.mu.Unlock()
		return nil
	}
	w := &waiter{kind: kindRead, ch: make(chan struct{})}
	l.queue = append(l.queue, w)
	l.mu.Unlock()

	select {
	case <-w.ch:
		return nil
	case <-ctx.Done():
		return l.abortWait(w, ctx)
	}
}

// abortWait resolves a wait whose context finished. If the grant raced with
// the cancellation and won, the acquisition stands.
func (l *RWLock) abortWait(w *waiter, ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if w.granted {
		return nil
	}
	w.canceled = true
	l.removeLocked(w)
	l.processQueueLocked()
	return ctx.Err()
}

// Unlock releases the exclusive hold. It returns ErrNotHeld without changing
// any state if no exclusive hold is active.
func (l *RWLock) Unlock() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.writer {
		return ErrNotHeld
	}
	l.writer = false
	l.processQueueLocked()
	return nil
}

// RUnlock releases one shared hold. It returns ErrNotHeld without changing
// any state if no shared hold is active.
func (l *RWLock) RUnlock() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.readers == 0 {
		return ErrNotHeld
	}
	l.readers--
	if l.readers == 0 {
		l.processQueueLocked()
	}
	return nil
}

// Downgrade converts the active exclusive hold into a shared hold, retaining
// exactly one read token for the caller. Readers queued ahead of the first
// queued writer are granted as a batch; readers queued behind a writer keep
// waiting. It returns ErrNotHeld without changing state if no exclusive hold
// is active.
func (l *RWLock) Downgrade() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.writer {
		return ErrNotHeld
	}
	l.writer = false
	l.readers++ // the downgrader's retained read token
	l.processQueueLocked()
	return nil
}

func (l *RWLock) removeLocked(w *waiter) {
	for i, q := range l.queue {
		if q == w {
			l.queue = append(l.queue[:i], l.queue[i+1:]...)
			return
		}
	}
}

// processQueueLocked grants waiters from the head of the queue: consecutive
// readers are granted as a batch, a head writer is granted only when the lock
// is fully free. Canceled waiters are dropped. l.mu must be held.
func (l *RWLock) processQueueLocked() {
	for len(l.queue) > 0 {
		w := l.queue[0]
		if w.canceled {
			l.queue = l.queue[1:]
			continue
		}
		switch w.kind {
		case kindRead:
			if l.writer {
				return
			}
			l.readers++
			l.grantLocked(w)
		case kindWrite:
			if l.writer || l.readers > 0 {
				return
			}
			l.writer = true
			l.grantLocked(w)
			return
		}
	}
}

func (l *RWLock) grantLocked(w *waiter) {
	l.queue = l.queue[1:]
	w.granted = true
	close(w.ch)
}
