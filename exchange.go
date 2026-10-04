// Package exchange implements a result-exchange queue: producers put items,
// consumers atomically claim at most k items per call, and producers may
// cancel items that have not been claimed yet. Every mutating operation
// linearizes under a single mutex and appends to a state history, so the
// full evolution of the queue can be replayed and audited.
package exchange

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// State is the lifecycle state of an item.
type State int

const (
	Pending State = iota
	Claimed
	Cancelled
)

func (s State) String() string {
	switch s {
	case Pending:
		return "pending"
	case Claimed:
		return "claimed"
	case Cancelled:
		return "cancelled"
	}
	return "unknown"
}

// Item is a unit of result stored in the exchange.
type Item struct {
	ID    int
	Value any
	State State
}

// OpKind identifies the operation recorded in a history event.
type OpKind string

const (
	OpPut          OpKind = "put"
	OpClaim        OpKind = "claim"
	OpClaimTimeout OpKind = "claim-timeout"
	OpCancel       OpKind = "cancel"
	OpCancelMiss   OpKind = "cancel-miss" // cancel of a non-pending item
)

// Event is one linearized step in the exchange history. PendingAfter is the
// snapshot of pending item IDs immediately after the operation took effect.
type Event struct {
	Seq          int
	Op           OpKind
	IDs          []int // items affected by the operation
	PendingAfter []int
}

// Exchange is a goroutine-safe result-exchange queue.
type Exchange struct {
	mu      sync.Mutex
	cond    sync.Cond
	items   map[int]*Item
	queue   []int // pending item IDs, FIFO
	history []Event
	nextID  int
	seq     int
}

// New returns an empty Exchange.
func New() *Exchange {
	e := &Exchange{items: make(map[int]*Item)}
	e.cond.L = &e.mu
	return e
}

// Put appends a new pending item and returns its ID.
func (e *Exchange) Put(v any) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	id := e.nextID
	e.nextID++
	e.items[id] = &Item{ID: id, Value: v, State: Pending}
	e.queue = append(e.queue, id)
	e.record(OpPut, []int{id})
	e.cond.Broadcast()
	return id
}

// Claim atomically takes up to k pending items (FIFO). If no item is
// available it waits up to timeout; on timeout it returns nil and leaves the
// queue unchanged. The whole batch linearizes as a single event.
func (e *Exchange) Claim(k int, timeout time.Duration) []*Item {
	if k <= 0 {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()

	if len(e.queue) == 0 && timeout > 0 {
		deadline := time.Now().Add(timeout)
		timer := time.AfterFunc(timeout, func() {
			e.mu.Lock()
			e.cond.Broadcast()
			e.mu.Unlock()
		})
		for len(e.queue) == 0 {
			e.cond.Wait()
			if len(e.queue) == 0 && !time.Now().Before(deadline) {
				timer.Stop()
				e.record(OpClaimTimeout, nil)
				return nil
			}
		}
		timer.Stop()
	}
	if len(e.queue) == 0 {
		e.record(OpClaimTimeout, nil)
		return nil
	}

	n := k
	if n > len(e.queue) {
		n = len(e.queue)
	}
	ids := make([]int, n)
	copy(ids, e.queue[:n])
	e.queue = e.queue[n:]
	out := make([]*Item, n)
	for i, id := range ids {
		it := e.items[id]
		it.State = Claimed
		out[i] = it
	}
	e.record(OpClaim, ids)
	return out
}

// Cancel retracts the item with the given ID, but only if it is still
// pending. It reports whether the cancellation took effect.
func (e *Exchange) Cancel(id int) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	it, ok := e.items[id]
	if !ok || it.State != Pending {
		e.record(OpCancelMiss, []int{id})
		return false
	}
	it.State = Cancelled
	for i, qid := range e.queue {
		if qid == id {
			e.queue = append(e.queue[:i], e.queue[i+1:]...)
			break
		}
	}
	e.record(OpCancel, []int{id})
	return true
}

// History returns a copy of the linearized event log.
func (e *Exchange) History() []Event {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]Event, len(e.history))
	copy(out, e.history)
	return out
}

// Counts summarizes how many items are in each state.
func (e *Exchange) Counts() (pending, claimed, cancelled int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, it := range e.items {
		switch it.State {
		case Pending:
			pending++
		case Claimed:
			claimed++
		case Cancelled:
			cancelled++
		}
	}
	return
}

func (e *Exchange) record(op OpKind, ids []int) {
	pending := make([]int, len(e.queue))
	copy(pending, e.queue)
	e.history = append(e.history, Event{Seq: e.seq, Op: op, IDs: ids, PendingAfter: pending})
	e.seq++
}

// String renders the history as a human-readable state log.
func (e *Exchange) String() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var b strings.Builder
	for _, ev := range e.history {
		fmt.Fprintf(&b, "#%02d %-13s ids=%v pending=%v\n", ev.Seq, ev.Op, ev.IDs, ev.PendingAfter)
	}
	return b.String()
}
