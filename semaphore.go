// Package semaphore implements a weighted semaphore with dynamic capacity.
//
// The total capacity may be grown or shrunk at runtime via Resize. Shrinking
// never revokes tokens already handed out: while the in-use count exceeds the
// capacity (over-commitment), no new tokens are granted until enough releases
// bring the in-use count back below the capacity.
//
// Waiters are served in strict FIFO order. Cancelling a waiter removes it from
// the queue and immediately re-evaluates the head of the queue, so a cancelled
// head waiter never leaves a hole that blocks the waiters behind it.
//
// Conservation invariant: a token is granted only when inUse+n <= capacity at
// grant time. Transiently inUse may exceed capacity (after a shrink), which is
// permitted, but no new over-capacity grant is ever made.
package semaphore

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrInvalidSize is returned for non-positive acquire/release sizes.
var ErrInvalidSize = errors.New("semaphore: size must be positive")

type waiter struct {
	n     int64
	ready chan struct{} // closed when the request is granted
}

// Semaphore is a weighted semaphore with adjustable capacity.
type Semaphore struct {
	mu       sync.Mutex
	capacity int64
	inUse    int64
	waiters  *list.List // FIFO queue of *waiter
}

// New returns a Semaphore with the given total capacity.
// It panics if capacity is negative.
func New(capacity int64) *Semaphore {
	if capacity < 0 {
		panic("semaphore: negative capacity")
	}
	return &Semaphore{
		capacity: capacity,
		waiters:  list.New(),
	}
}

// Acquire blocks until n tokens are available and granted in FIFO order, or
// until ctx is done. If the context is cancelled while waiting, the pending
// request is removed from the queue and ctx.Err() is returned; tokens are
// never leaked. A request that was already granted when the context fires is
// honoured and nil is returned.
func (s *Semaphore) Acquire(ctx context.Context, n int64) error {
	if n <= 0 {
		return ErrInvalidSize
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	// Fast path: no one is waiting and the request fits.
	if s.waiters.Len() == 0 && s.capacity-s.inUse >= n {
		s.inUse += n
		s.mu.Unlock()
		return nil
	}
	w := &waiter{n: n, ready: make(chan struct{})}
	elem := s.waiters.PushBack(w)
	s.mu.Unlock()

	select {
	case <-w.ready:
		return nil
	case <-ctx.Done():
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-w.ready:
		// Granted concurrently with the cancellation; the grant stands.
		return nil
	default:
	}
	s.waiters.Remove(elem)
	// The removed waiter may have been at the head of the queue; re-evaluate
	// so the waiters behind it are not stuck behind a hole.
	s.grantLocked()
	return ctx.Err()
}

// TryAcquire acquires n tokens without blocking. It reports whether the
// tokens were granted. It never jumps the FIFO queue: if waiters are queued,
// TryAcquire fails.
func (s *Semaphore) TryAcquire(n int64) bool {
	if n <= 0 {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.waiters.Len() != 0 || s.capacity-s.inUse < n {
		return false
	}
	s.inUse += n
	return true
}

// Release returns n tokens to the semaphore and grants pending waiters in
// FIFO order. It panics if more tokens are released than are in use.
func (s *Semaphore) Release(n int64) {
	if n <= 0 {
		panic("semaphore: released size must be positive")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inUse-n < 0 {
		panic("semaphore: released more tokens than are in use")
	}
	s.inUse -= n
	s.grantLocked()
}

// Resize sets a new total capacity. Growing may immediately unblock queued
// waiters. Shrinking never revokes tokens already granted: while inUse exceeds
// the new capacity, no new grants are made until releases restore headroom.
// It panics if newCapacity is negative.
func (s *Semaphore) Resize(newCapacity int64) {
	if newCapacity < 0 {
		panic("semaphore: negative capacity")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.capacity = newCapacity
	s.grantLocked()
}

// grantLocked serves waiters from the head of the FIFO queue while the head
// request fits within the remaining capacity. Strict FIFO: a head request
// that does not fit blocks everything behind it.
func (s *Semaphore) grantLocked() {
	for e := s.waiters.Front(); e != nil; e = s.waiters.Front() {
		w := e.Value.(*waiter)
		if s.capacity-s.inUse < w.n {
			return
		}
		s.inUse += w.n
		s.waiters.Remove(e)
		close(w.ready)
	}
}

// Capacity returns the current total capacity.
func (s *Semaphore) Capacity() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.capacity
}

// InUse returns the number of tokens currently granted and not yet released.
func (s *Semaphore) InUse() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.inUse
}

// Waiters returns the number of queued (not yet granted) acquire requests.
func (s *Semaphore) Waiters() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.waiters.Len()
}

// CheckConservation verifies the conservation invariant and returns a
// descriptive error if it is violated.
//
// inUse must never be negative and capacity must never be negative. inUse is
// allowed to exceed capacity transiently (the aftermath of a shrink), because
// grants are only made while inUse+n <= capacity; what is forbidden — and
// checked here — is any state that could only result from a new over-capacity
// grant: queued waiters that would already fit must have been served, so if
// inUse <= capacity the head waiter (if any) must not fit either.
func (s *Semaphore) CheckConservation() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.capacity < 0 {
		return fmt.Errorf("semaphore: negative capacity %d", s.capacity)
	}
	if s.inUse < 0 {
		return fmt.Errorf("semaphore: negative in-use count %d", s.inUse)
	}
	if s.inUse <= s.capacity {
		if e := s.waiters.Front(); e != nil {
			w := e.Value.(*waiter)
			if s.capacity-s.inUse >= w.n {
				return fmt.Errorf("semaphore: head waiter for %d tokens fits (capacity %d, in use %d) but was not granted",
					w.n, s.capacity, s.inUse)
			}
		}
	}
	return nil
}
