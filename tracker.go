// Package readwait provides follower-side read synchronization: a read
// registers the commit index it observed and returns only after the state
// machine has applied up to that index. Timeouts report "not reached"
// explicitly instead of surfacing a stale value, and cancellation removes
// the registered waiter.
package readwait

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// NotAppliedError is returned when the applied index does not reach the
// registered target before the deadline. It makes the miss explicit so
// callers never mistake a stale value for a current one.
type NotAppliedError struct {
	Target  uint64
	Applied uint64
}

func (e *NotAppliedError) Error() string {
	return fmt.Sprintf("readwait: applied index %d has not reached target %d", e.Applied, e.Target)
}

type waiter struct {
	target uint64
	done   chan struct{}
}

// Tracker tracks the applied index and wakes registered read waiters once
// their target index has been applied. The applied index is monotonic and
// never regresses.
type Tracker struct {
	mu      sync.Mutex
	clock   Clock
	applied uint64
	nextID  uint64
	waiters map[uint64]*waiter
}

// NewTracker returns a Tracker driven by clock; nil selects RealClock.
func NewTracker(clock Clock) *Tracker {
	if clock == nil {
		clock = RealClock{}
	}
	return &Tracker{clock: clock, waiters: make(map[uint64]*waiter)}
}

// Applied returns the current applied index.
func (t *Tracker) Applied() uint64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.applied
}

// WaiterCount returns the number of registered waiters.
func (t *Tracker) WaiterCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.waiters)
}

// WaitApplied registers target and blocks until the applied index reaches
// it, the timeout elapses, or ctx is canceled.
//
// A timeout returns *NotAppliedError — never a stale success. Canceling ctx
// removes the waiter and returns ctx.Err(). A non-positive timeout disables
// the deadline.
func (t *Tracker) WaitApplied(ctx context.Context, target uint64, timeout time.Duration) error {
	t.mu.Lock()
	if t.applied >= target {
		t.mu.Unlock()
		return nil
	}
	id := t.nextID
	t.nextID++
	w := &waiter{target: target, done: make(chan struct{})}
	t.waiters[id] = w
	t.mu.Unlock()

	var fired <-chan struct{}
	var timer Timer
	if timeout > 0 {
		ch := make(chan struct{})
		fired = ch
		timer = t.clock.AfterFunc(timeout, func() { close(ch) })
	}

	select {
	case <-w.done:
		if timer != nil {
			timer.Stop()
		}
		return nil
	case <-fired:
		removed, applied := t.removeWaiter(id)
		if !removed {
			return nil // woken concurrently with the timeout
		}
		return &NotAppliedError{Target: target, Applied: applied}
	case <-ctx.Done():
		if timer != nil {
			timer.Stop()
		}
		removed, _ := t.removeWaiter(id)
		if !removed {
			return nil // woken concurrently with the cancellation
		}
		return ctx.Err()
	}
}

func (t *Tracker) removeWaiter(id uint64) (removed bool, applied uint64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, ok := t.waiters[id]; !ok {
		return false, t.applied
	}
	delete(t.waiters, id)
	return true, t.applied
}

// NotifyApplied records that entries up to index have been applied and wakes
// every waiter whose target is now satisfied, as one batch. The applied
// index never regresses; a lower index is ignored. It returns the number of
// waiters woken.
func (t *Tracker) NotifyApplied(index uint64) int {
	t.mu.Lock()
	if index > t.applied {
		t.applied = index
	}
	woken := t.collectWokenLocked()
	t.mu.Unlock()
	wake(woken)
	return len(woken)
}

// InstallSnapshot advances the applied index to the snapshot's last included
// index and wakes satisfied waiters. It never regresses the applied index:
// a snapshot at or behind the current applied index is rejected with false.
func (t *Tracker) InstallSnapshot(lastIncludedIndex uint64) bool {
	t.mu.Lock()
	if lastIncludedIndex <= t.applied {
		t.mu.Unlock()
		return false
	}
	t.applied = lastIncludedIndex
	woken := t.collectWokenLocked()
	t.mu.Unlock()
	wake(woken)
	return true
}

func (t *Tracker) collectWokenLocked() []*waiter {
	var woken []*waiter
	for id, w := range t.waiters {
		if w.target <= t.applied {
			woken = append(woken, w)
			delete(t.waiters, id)
		}
	}
	return woken
}

func wake(waiters []*waiter) {
	for _, w := range waiters {
		close(w.done)
	}
}
