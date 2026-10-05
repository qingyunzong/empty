// Package semaphore implements a dynamically resizable, FIFO, cancellable
// weighted semaphore using only the Go standard library.
//
// Semantics:
//   - The total capacity may be changed at runtime via Resize, including
//     shrinking below the number of tokens currently in use. Tokens already
//     handed out are never revoked.
//   - While the semaphore is over capacity (used > total), no new tokens
//     are granted until enough tokens are released.
//   - Waiters are served strictly in FIFO order; a waiting request is only
//     granted once every request ahead of it has been served or cancelled.
//   - Cancelling a waiting Acquire removes it from the queue and
//     immediately re-evaluates the new head, so cancellation never leaves
//     a hole blocking the head of the queue.
//   - Conservation: a grant happens only when used+n <= total at grant
//     time. After a shrink, used may temporarily exceed total, but no new
//     grant may push it further above total.
package semaphore

import (
	"container/list"
	"context"
	"fmt"
	"sync"
)

type waiter struct {
	n       int64
	ch      chan struct{} // closed when the grant is made
	granted bool
}

// Semaphore is a weighted semaphore with a dynamically resizable capacity.
type Semaphore struct {
	mu      sync.Mutex
	total   int64 // current capacity
	used    int64 // tokens currently checked out
	waiters list.List
}

// New returns a Semaphore with the given total capacity.
func New(total int64) *Semaphore {
	if total < 0 {
		panic("semaphore: negative capacity")
	}
	return &Semaphore{total: total}
}

// Total reports the current capacity.
func (s *Semaphore) Total() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.total
}

// Used reports the number of tokens currently checked out. It may exceed
// Total() temporarily after a shrink.
func (s *Semaphore) Used() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.used
}

// Waiters reports how many Acquire calls are currently queued.
func (s *Semaphore) Waiters() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.waiters.Len()
}

// Resize changes the total capacity. Shrinking never revokes tokens that
// are already checked out; while used exceeds the new total, no further
// grants are made until releases bring usage back below capacity. Growing
// may immediately unblock queued waiters in FIFO order.
func (s *Semaphore) Resize(total int64) {
	if total < 0 {
		panic("semaphore: negative capacity")
	}
	s.mu.Lock()
	s.total = total
	s.broadcastLocked()
	s.mu.Unlock()
}

// Acquire blocks until n tokens are granted, the context is cancelled, or
// the request becomes impossible (n exceeds the total capacity and no
// shrink could... n is validated against the current total only as a fast
// path; a request larger than capacity waits like any other until
// cancelled or the capacity grows).
//
// If the context is cancelled while waiting, the request is removed from
// the FIFO queue and the queue head is re-evaluated, so no hole is left
// behind. If the grant races with cancellation, the grant wins and nil is
// returned (the caller then owns the tokens and must Release them).
func (s *Semaphore) Acquire(ctx context.Context, n int64) error {
	if n <= 0 {
		return fmt.Errorf("semaphore: acquire of non-positive count %d", n)
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	// Fast path: nobody waiting and the grant keeps us within capacity.
	if s.waiters.Len() == 0 && s.used+n <= s.total {
		s.used += n
		s.mu.Unlock()
		return nil
	}
	w := &waiter{n: n, ch: make(chan struct{})}
	e := s.waiters.PushBack(w)
	s.mu.Unlock()

	select {
	case <-w.ch:
		return nil
	case <-ctx.Done():
		s.mu.Lock()
		if w.granted {
			// The grant raced with cancellation; the tokens are ours.
			s.mu.Unlock()
			return nil
		}
		s.waiters.Remove(e)
		// Re-evaluate the head so a cancelled head waiter never
		// blocks the requests queued behind it.
		s.broadcastLocked()
		s.mu.Unlock()
		return ctx.Err()
	}
}

// TryAcquire grants n tokens without blocking if doing so keeps usage
// within capacity and no waiter is queued (FIFO fairness). It reports
// whether the grant was made.
func (s *Semaphore) TryAcquire(n int64) bool {
	if n <= 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.waiters.Len() != 0 || s.used+n > s.total {
		return false
	}
	s.used += n
	return true
}

// Release returns n tokens to the semaphore and wakes queued waiters in
// FIFO order. It panics if more tokens are released than are checked out.
func (s *Semaphore) Release(n int64) {
	if n <= 0 {
		panic("semaphore: release of non-positive count")
	}
	s.mu.Lock()
	if s.used < n {
		s.mu.Unlock()
		panic("semaphore: released more tokens than are in use")
	}
	s.used -= n
	s.broadcastLocked()
	s.mu.Unlock()
}

// broadcastLocked grants tokens to queued waiters in strict FIFO order.
// A waiter is granted only while it is at the head of the queue and the
// grant keeps used within total; the first unsatisfiable head stops the
// scan, so no request ever overtakes an earlier one and no grant is made
// while the semaphore is at or over capacity.
func (s *Semaphore) broadcastLocked() {
	for {
		front := s.waiters.Front()
		if front == nil {
			return
		}
		w := front.Value.(*waiter)
		if s.used+w.n > s.total {
			return
		}
		s.used += w.n
		w.granted = true
		close(w.ch)
		s.waiters.Remove(front)
	}
}
