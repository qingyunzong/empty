// Package timer provides a deterministic timer library driven by an
// integer logical clock.
//
// Timers are scheduled relative to the clock's current tick and fire when
// the clock is advanced past their deadline. Timers due at the same tick
// fire in ascending ID order. A callback that registers a new timer for
// the current tick appends it to the end of the current round, so it still
// fires within the same Advance call; a per-call callback budget bounds
// the number of invocations so runaway re-registration cannot loop
// forever. Rescheduling or cancelling a timer bumps its generation and
// invalidates every previously issued handle for it.
package timer

import (
	"container/heap"
	"errors"
)

// ErrBudgetExhausted is returned by Advance and AdvanceTo when the
// per-call callback budget is exhausted before all due timers have fired.
var ErrBudgetExhausted = errors.New("timer: callback budget exhausted")

// Event records a single timer firing, in firing order.
type Event struct {
	Tick int64
	ID   int
}

// Timer is a handle to a scheduled timer. A handle is bound to a
// generation: rescheduling or cancelling the timer invalidates all
// previously issued handles for it, and operations through a stale handle
// are no-ops.
type Timer struct {
	id  int
	gen int
}

// ID returns the timer's identifier. IDs are issued in registration order.
func (t Timer) ID() int { return t.id }

type entry struct {
	id        int
	deadline  int64
	gen       int
	cb        func()
	heapIndex int
}

// Clock is an integer logical clock that schedules and fires timers.
type Clock struct {
	now     int64
	nextID  int
	entries map[int]*entry
	queue   entryHeap
	budget  int
	events  []Event
}

// NewClock creates a clock starting at tick 0. budget caps the number of
// callbacks a single Advance or AdvanceTo call may invoke and must be
// positive, so re-registering callbacks cannot loop forever.
func NewClock(budget int) *Clock {
	if budget <= 0 {
		panic("timer: budget must be positive")
	}
	return &Clock{entries: make(map[int]*entry), budget: budget}
}

// Now returns the current logical tick.
func (c *Clock) Now() int64 { return c.now }

// Events returns the recorded firing events, in firing order.
func (c *Clock) Events() []Event { return append([]Event(nil), c.events...) }

// Pending reports the number of scheduled (unfired, uncancelled) timers.
func (c *Clock) Pending() int { return len(c.queue) }

// Schedule registers cb to run delay ticks from now and returns its
// handle. A zero delay targets the current tick; when registration happens
// inside a callback during Advance, the timer is appended to the end of
// the current round.
func (c *Clock) Schedule(delay int64, cb func()) Timer {
	if delay < 0 {
		panic("timer: negative delay")
	}
	id := c.nextID
	c.nextID++
	e := &entry{id: id, deadline: c.now + delay, cb: cb}
	c.entries[id] = e
	heap.Push(&c.queue, e)
	return Timer{id: id, gen: e.gen}
}

func (c *Clock) lookup(t Timer) *entry {
	e, ok := c.entries[t.id]
	if !ok || e.gen != t.gen {
		return nil
	}
	return e
}

// Reschedule moves the timer to fire delay ticks from now and returns the
// new handle. It reports false, doing nothing, if the handle is stale.
func (c *Clock) Reschedule(t Timer, delay int64) (Timer, bool) {
	if delay < 0 {
		panic("timer: negative delay")
	}
	e := c.lookup(t)
	if e == nil {
		return Timer{}, false
	}
	e.deadline = c.now + delay
	e.gen++
	if e.heapIndex >= 0 {
		heap.Fix(&c.queue, e.heapIndex)
	} else {
		// The timer is currently firing; requeue it.
		heap.Push(&c.queue, e)
	}
	return Timer{id: e.id, gen: e.gen}, true
}

// Cancel removes the timer. It reports false, doing nothing, if the
// handle is stale.
func (c *Clock) Cancel(t Timer) bool {
	e := c.lookup(t)
	if e == nil {
		return false
	}
	if e.heapIndex >= 0 {
		heap.Remove(&c.queue, e.heapIndex)
	}
	delete(c.entries, e.id)
	return true
}

// Advance moves the clock forward by delta ticks, firing due timers.
func (c *Clock) Advance(delta int64) error {
	if delta < 0 {
		panic("timer: negative delta")
	}
	return c.AdvanceTo(c.now + delta)
}

// AdvanceTo moves the clock forward to tick, firing every timer whose
// deadline is at or before tick. Timers due at the same tick fire in
// ascending ID order. If the callback budget is exhausted, AdvanceTo stops
// early, leaves the clock at the last fired timer's tick, and returns
// ErrBudgetExhausted; unfired timers stay pending for a later call.
func (c *Clock) AdvanceTo(tick int64) error {
	if tick < c.now {
		panic("timer: cannot move clock backwards")
	}
	spent := 0
	for len(c.queue) > 0 && c.queue[0].deadline <= tick {
		if spent >= c.budget {
			return ErrBudgetExhausted
		}
		e := heap.Pop(&c.queue).(*entry)
		e.heapIndex = -1
		c.now = e.deadline
		spent++
		c.events = append(c.events, Event{Tick: e.deadline, ID: e.id})
		gen := e.gen
		e.cb()
		// The entry stays live while its callback runs so the callback
		// may reschedule or cancel its own timer. Drop it only if the
		// callback left the generation untouched.
		if cur, ok := c.entries[e.id]; ok && cur == e && e.gen == gen {
			delete(c.entries, e.id)
		}
	}
	c.now = tick
	return nil
}

// entryHeap is a min-heap ordered by (deadline, id).
type entryHeap []*entry

func (h entryHeap) Len() int { return len(h) }

func (h entryHeap) Less(i, j int) bool {
	if h[i].deadline != h[j].deadline {
		return h[i].deadline < h[j].deadline
	}
	return h[i].id < h[j].id
}

func (h entryHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].heapIndex = i
	h[j].heapIndex = j
}

func (h *entryHeap) Push(x any) {
	e := x.(*entry)
	e.heapIndex = len(*h)
	*h = append(*h, e)
}

func (h *entryHeap) Pop() any {
	old := *h
	n := len(old)
	e := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return e
}
