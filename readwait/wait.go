// Package readwait implements a read barrier for a replica store: a read
// registers the target commit index it depends on and only returns once the
// replica has applied up to that index. Timeouts and cancellations report
// "not reached" explicitly instead of returning a stale value.
package readwait

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrNotReached is returned when the context expires before the replica has
// applied up to the registered target index.
var ErrNotReached = errors.New("readwait: target commit index not reached before deadline")

type waiter struct {
	target uint64
	ch     chan struct{}
}

// Notifier tracks the replica's applied index and wakes registered waiters
// in batches whenever the applied index advances past their targets.
type Notifier struct {
	mu      sync.Mutex
	applied uint64
	nextID  uint64
	waiters map[uint64]waiter
}

func NewNotifier() *Notifier {
	return &Notifier{waiters: make(map[uint64]waiter)}
}

// Applied returns the highest applied index observed so far.
func (n *Notifier) Applied() uint64 {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.applied
}

// register adds a waiter for target and returns its notification channel
// along with a deregister func. If the target is already applied, the
// returned channel is closed and deregister is a no-op.
func (n *Notifier) register(target uint64) (<-chan struct{}, func()) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.applied >= target {
		ch := make(chan struct{})
		close(ch)
		return ch, func() {}
	}
	id := n.nextID
	n.nextID++
	ch := make(chan struct{})
	n.waiters[id] = waiter{target: target, ch: ch}
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			n.mu.Lock()
			defer n.mu.Unlock()
			delete(n.waiters, id)
		})
	}
}

// Wait blocks until the applied index reaches target or ctx is done. It
// registers the target first, so an apply racing the call is never missed.
// On ctx expiry the waiter is removed and ErrNotReached (wrapping ctx.Err())
// is returned; it never reports success for an unreached target.
func (n *Notifier) Wait(ctx context.Context, target uint64) error {
	ch, deregister := n.register(target)
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		deregister()
		// Re-check: the apply may have landed concurrently with the
		// deadline, in which case the read is safe to serve.
		select {
		case <-ch:
			return nil
		default:
		}
		return fmt.Errorf("%w: %w", ErrNotReached, ctx.Err())
	}
}

// Waiters returns the number of registered waiters; used by tests to verify
// that cancelled/timed-out waiters are removed.
func (n *Notifier) Waiters() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return len(n.waiters)
}

// applyTo advances the applied index to index (never backwards) and wakes
// every waiter whose target is now satisfied, in a single batch.
func (n *Notifier) applyTo(index uint64) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if index <= n.applied {
		return
	}
	n.applied = index
	for id, w := range n.waiters {
		if w.target <= index {
			close(w.ch)
			delete(n.waiters, id)
		}
	}
}
