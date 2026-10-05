// Package exchange implements a result-exchange queue.
//
// Producers append items and may cancel them; consumers atomically claim
// batches of up to k items. Every mutating operation is performed entirely
// under a single mutex, so a batch Claim and a Cancel always linearize as
// whole operations: an item is either claimed or cancelled, never both,
// and a claim batch is never interleaved with a cancellation.
//
// A Claim that times out before the queue becomes non-empty leaves the
// queue untouched. Cancel only withdraws items that are still unclaimed.
//
// Every operation appends to an in-memory state history that can be
// inspected via History or dumped via DumpHistory.
package exchange

import (
	"context"
	"fmt"
	"io"
	"sync"
)

// Item is a unit of result flowing through the exchange.
type Item struct {
	ID    string
	Value any
}

// EventKind identifies the type of a history event.
type EventKind int

const (
	EventProduce      EventKind = iota // item appended to the queue
	EventClaim                         // batch of up to K items claimed atomically
	EventClaimTimeout                  // claim gave up; queue left unchanged
	EventCancel                        // unclaimed item withdrawn
	EventCancelMiss                    // cancel of an unknown or already-claimed item
)

func (k EventKind) String() string {
	switch k {
	case EventProduce:
		return "produce"
	case EventClaim:
		return "claim"
	case EventClaimTimeout:
		return "claim-timeout"
	case EventCancel:
		return "cancel"
	case EventCancelMiss:
		return "cancel-miss"
	}
	return "unknown"
}

// Event records one state transition of the exchange.
type Event struct {
	Seq      int // monotonically increasing sequence number
	Kind     EventKind
	ItemIDs  []string // items affected (empty for timeouts)
	K        int      // requested batch size (claim events only)
	QueueLen int      // queue length after the event
}

func (ev Event) String() string {
	return fmt.Sprintf("#%d %-13s k=%d items=%v queue=%d", ev.Seq, ev.Kind, ev.K, ev.ItemIDs, ev.QueueLen)
}

// Exchange is a concurrency-safe result-exchange queue.
type Exchange struct {
	mu        sync.Mutex
	queue     []Item          // unclaimed items, FIFO
	claimed   map[string]Item // items handed out to consumers
	cancelled map[string]Item // items withdrawn by producers
	history   []Event
	changed   chan struct{} // closed and replaced to broadcast queue growth
}

// New returns an empty Exchange.
func New() *Exchange {
	return &Exchange{
		claimed:   make(map[string]Item),
		cancelled: make(map[string]Item),
		changed:   make(chan struct{}),
	}
}

// recordLocked appends an event; caller must hold e.mu.
func (e *Exchange) recordLocked(kind EventKind, k int, ids []string) {
	e.history = append(e.history, Event{
		Seq:      len(e.history),
		Kind:     kind,
		ItemIDs:  ids,
		K:        k,
		QueueLen: len(e.queue),
	})
}

// broadcastLocked wakes all waiting consumers; caller must hold e.mu.
func (e *Exchange) broadcastLocked() {
	close(e.changed)
	e.changed = make(chan struct{})
}

// Produce appends an item to the queue. It reports false, leaving the
// exchange unchanged, if the ID already exists in any state.
func (e *Exchange) Produce(it Item) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, ok := e.claimed[it.ID]; ok {
		return false
	}
	if _, ok := e.cancelled[it.ID]; ok {
		return false
	}
	for _, q := range e.queue {
		if q.ID == it.ID {
			return false
		}
	}
	e.queue = append(e.queue, it)
	e.recordLocked(EventProduce, 0, []string{it.ID})
	e.broadcastLocked()
	return true
}

// Claim atomically removes and returns up to k items in FIFO order.
//
// The whole batch is taken under the lock, so it linearizes as a single
// operation against any concurrent Cancel. While the queue is empty Claim
// blocks until an item is produced or ctx is done; on timeout or
// cancellation the queue is left completely unchanged and a
// EventClaimTimeout entry is recorded.
func (e *Exchange) Claim(ctx context.Context, k int) ([]Item, error) {
	if k <= 0 {
		return nil, nil
	}
	for {
		e.mu.Lock()
		if len(e.queue) > 0 {
			n := k
			if n > len(e.queue) {
				n = len(e.queue)
			}
			items := make([]Item, n)
			ids := make([]string, n)
			for i := 0; i < n; i++ {
				items[i] = e.queue[i]
				ids[i] = e.queue[i].ID
				e.claimed[e.queue[i].ID] = e.queue[i]
			}
			e.queue = append([]Item(nil), e.queue[n:]...)
			e.recordLocked(EventClaim, k, ids)
			e.mu.Unlock()
			return items, nil
		}
		ch := e.changed
		e.mu.Unlock()

		select {
		case <-ch:
		case <-ctx.Done():
			e.mu.Lock()
			e.recordLocked(EventClaimTimeout, k, nil)
			e.mu.Unlock()
			return nil, ctx.Err()
		}
	}
}

// Cancel withdraws the item with the given ID, but only if it is still
// sitting unclaimed in the queue. It reports false if the item was already
// claimed, already cancelled, or never existed.
func (e *Exchange) Cancel(id string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for i, it := range e.queue {
		if it.ID == id {
			e.queue = append(e.queue[:i], e.queue[i+1:]...)
			e.cancelled[id] = it
			e.recordLocked(EventCancel, 0, []string{id})
			return true
		}
	}
	e.recordLocked(EventCancelMiss, 0, []string{id})
	return false
}

// Snapshot returns a copy of the currently queued (unclaimed) items.
func (e *Exchange) Snapshot() []Item {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]Item(nil), e.queue...)
}

// Claimed returns a copy of the claimed item set.
func (e *Exchange) Claimed() map[string]Item {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string]Item, len(e.claimed))
	for id, it := range e.claimed {
		out[id] = it
	}
	return out
}

// Cancelled returns a copy of the cancelled item set.
func (e *Exchange) Cancelled() map[string]Item {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make(map[string]Item, len(e.cancelled))
	for id, it := range e.cancelled {
		out[id] = it
	}
	return out
}

// History returns a copy of the recorded state-transition history.
func (e *Exchange) History() []Event {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]Event(nil), e.history...)
}

// DumpHistory writes the recorded state history to w.
func (e *Exchange) DumpHistory(w io.Writer) {
	for _, ev := range e.History() {
		fmt.Fprintln(w, ev)
	}
}
