// Package rwlock implements a fair FIFO read-write mutex that supports
// downgrading an exclusive hold to a shared hold (retaining one read
// token), batch-granting readers queued ahead of a writer, and prompt
// queue advancement when the head waiter is canceled.
package rwlock

import (
	"context"
	"sync"
)

type waiterKind int

const (
	reader waiterKind = iota
	writer
)

type waiter struct {
	kind    waiterKind
	grant   chan struct{}
	granted bool
}

// RWLock is a fair read-write lock. The zero value is ready to use.
//
// Locking rules:
//   - A writer holds the lock exclusively.
//   - Any number of readers may hold the lock concurrently.
//   - Waiters are served in FIFO order: readers queued before a writer
//     are granted as a batch; readers queued after a writer may not
//     bypass it.
type RWLock struct {
	mu      sync.Mutex
	readers int  // active read tokens
	writer  bool // exclusive hold active
	queue   []*waiter
}

// Lock acquires the exclusive lock, blocking until available.
func (l *RWLock) Lock() { _ = l.LockContext(context.Background()) }

// RLock acquires a shared read token, blocking until available.
func (l *RWLock) RLock() { _ = l.RLockContext(context.Background()) }

// LockContext acquires the exclusive lock, or returns ctx.Err() if the
// context is canceled while waiting.
func (l *RWLock) LockContext(ctx context.Context) error {
	return l.acquire(ctx, writer)
}

// RLockContext acquires a shared read token, or returns ctx.Err() if the
// context is canceled while waiting.
func (l *RWLock) RLockContext(ctx context.Context) error {
	return l.acquire(ctx, reader)
}

func (l *RWLock) acquire(ctx context.Context, kind waiterKind) error {
	l.mu.Lock()
	if len(l.queue) == 0 && l.canHoldLocked(kind) {
		l.takeLocked(kind)
		l.mu.Unlock()
		return nil
	}
	w := &waiter{kind: kind, grant: make(chan struct{})}
	l.queue = append(l.queue, w)
	l.advanceLocked()
	l.mu.Unlock()

	select {
	case <-w.grant:
		return nil
	case <-ctx.Done():
		l.mu.Lock()
		if w.granted {
			// The grant raced with cancellation; the acquisition stands.
			l.mu.Unlock()
			return nil
		}
		l.removeLocked(w)
		// Removing the head may unblock the waiters behind it.
		l.advanceLocked()
		l.mu.Unlock()
		return ctx.Err()
	}
}

// Unlock releases the exclusive hold. It reports whether a hold was
// actually released; a repeated Unlock is a no-op and returns false.
func (l *RWLock) Unlock() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.writer {
		return false
	}
	l.writer = false
	l.advanceLocked()
	return true
}

// RUnlock releases one read token. It reports whether a token was
// actually released; releasing without a token is a no-op and returns
// false.
func (l *RWLock) RUnlock() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.readers == 0 {
		return false
	}
	l.readers--
	if l.readers == 0 {
		l.advanceLocked()
	}
	return true
}

// Downgrade converts the exclusive hold into a shared hold, retaining
// exactly one read token for the caller. Queued readers ahead of the
// first queued writer are granted as a batch. It reports whether a
// downgrade happened; calling it without holding the exclusive lock is
// a no-op and returns false.
func (l *RWLock) Downgrade() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.writer {
		return false
	}
	l.writer = false
	l.readers++ // retain one read token
	l.advanceLocked()
	return true
}

func (l *RWLock) canHoldLocked(kind waiterKind) bool {
	if l.writer {
		return false
	}
	return kind == reader || l.readers == 0
}

func (l *RWLock) takeLocked(kind waiterKind) {
	if kind == writer {
		l.writer = true
	} else {
		l.readers++
	}
}

// advanceLocked grants waiters from the head of the queue while the
// current state allows it. Consecutive readers at the head are granted
// as a batch; a writer is granted only when no read tokens remain.
func (l *RWLock) advanceLocked() {
	if l.writer {
		return
	}
	for len(l.queue) > 0 {
		w := l.queue[0]
		if w.kind == writer {
			if l.readers > 0 {
				return
			}
			l.writer = true
			l.grantLocked(w)
			return
		}
		l.readers++
		l.grantLocked(w)
	}
}

func (l *RWLock) grantLocked(w *waiter) {
	w.granted = true
	l.queue = l.queue[1:]
	close(w.grant)
}

func (l *RWLock) removeLocked(target *waiter) {
	for i, w := range l.queue {
		if w == target {
			l.queue = append(l.queue[:i], l.queue[i+1:]...)
			return
		}
	}
}

// queued reports the number of waiters currently in the queue.
// It exists for tests and diagnostics.
func (l *RWLock) queued() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.queue)
}
