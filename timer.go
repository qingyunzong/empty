// Package timer implements a deterministic timer library on top of an
// integer logical clock.
//
// The clock only moves when AdvanceTo is called. Timers are registered with
// Schedule, may be moved to a new deadline with Reschedule, and may be
// withdrawn with Cancel. Timers expiring at the same tick fire in ascending
// ID order. A callback that registers a new timer due at the tick currently
// being processed appends it to the end of the current round, so it still
// fires within the same AdvanceTo call. Because such re-registration could
// otherwise loop forever, every clock carries a mandatory callback budget
// that caps how many callbacks a single AdvanceTo call may run.
//
// Every timer is identified by a Handle carrying a generation number. Each
// successful Reschedule bumps the generation, so operations performed
// through an older handle are stale and silently have no effect.
//
// All operations and firings are appended to an event log that tests and
// embedders can use as a reference to verify behaviour.
package timer

import "container/heap"

// Callback is invoked when a timer fires. It receives the clock so it can
// register follow-up timers, reschedule, or cancel others.
type Callback func(c *Clock)

// Handle identifies one generation of a timer. Handles are returned by
// Schedule and Reschedule and must be passed back to Reschedule and Cancel.
// A handle whose generation is no longer current is stale: operations
// through it are no-ops.
type Handle struct {
	ID         uint64
	Generation uint64
}

// EventKind classifies entries in the clock's event log.
type EventKind uint8

const (
	EventScheduled EventKind = iota
	EventRescheduled
	EventCancelled
	EventFired
)

func (k EventKind) String() string {
	switch k {
	case EventScheduled:
		return "scheduled"
	case EventRescheduled:
		return "rescheduled"
	case EventCancelled:
		return "cancelled"
	case EventFired:
		return "fired"
	}
	return "unknown"
}

// Event is one entry in the clock's reference event log.
type Event struct {
	Tick     uint64    // logical time at which the event was recorded
	Kind     EventKind // what happened
	Timer    uint64    // ID of the affected timer
	Deadline uint64    // deadline after the event (the due tick for EventFired)
}

// Clock is an integer logical clock with a timer heap and an event log.
// The zero value is not usable; construct one with New.
type Clock struct {
	now     uint64
	seq     uint64
	budget  int
	timers  map[uint64]*timerState
	pending entryHeap
	events  []Event
}

type timerState struct {
	deadline   uint64
	generation uint64
	callback   Callback
}

// New returns a Clock whose logical time starts at 0. budget is the maximum
// number of callbacks a single AdvanceTo call may run; it must be positive
// so that callbacks re-registering timers due at the current tick cannot
// loop forever.
func New(budget int) *Clock {
	if budget <= 0 {
		panic("timer: callback budget must be positive")
	}
	return &Clock{
		budget: budget,
		timers: make(map[uint64]*timerState),
	}
}

// Now reports the current logical time.
func (c *Clock) Now() uint64 { return c.now }

// Budget reports the per-AdvanceTo callback budget.
func (c *Clock) Budget() int { return c.budget }

// Pending reports the number of live (scheduled, not yet fired or
// cancelled) timers.
func (c *Clock) Pending() int { return len(c.timers) }

// Events returns a copy of the reference event log.
func (c *Clock) Events() []Event {
	out := make([]Event, len(c.events))
	copy(out, c.events)
	return out
}

func (c *Clock) record(e Event) { c.events = append(c.events, e) }

// Schedule registers cb to fire at the given deadline tick and returns the
// timer's handle. A deadline at or before the current tick is due
// immediately: if called from a callback during AdvanceTo, the timer joins
// the end of the current round.
func (c *Clock) Schedule(deadline uint64, cb Callback) Handle {
	if cb == nil {
		panic("timer: nil callback")
	}
	c.seq++
	id := c.seq
	c.timers[id] = &timerState{deadline: deadline, callback: cb}
	heap.Push(&c.pending, entry{deadline: deadline, id: id})
	c.record(Event{Tick: c.now, Kind: EventScheduled, Timer: id, Deadline: deadline})
	return Handle{ID: id}
}

// Reschedule moves a live timer to a new deadline. On success it bumps the
// timer's generation and returns the updated handle; the previous handle
// becomes stale. It reports false without any effect when the handle is
// stale, cancelled, or already fired.
func (c *Clock) Reschedule(h Handle, deadline uint64) (Handle, bool) {
	tm, ok := c.timers[h.ID]
	if !ok || tm.generation != h.Generation {
		return Handle{}, false
	}
	tm.generation++
	tm.deadline = deadline
	heap.Push(&c.pending, entry{deadline: deadline, id: h.ID, generation: tm.generation})
	c.record(Event{Tick: c.now, Kind: EventRescheduled, Timer: h.ID, Deadline: deadline})
	return Handle{ID: h.ID, Generation: tm.generation}, true
}

// Cancel withdraws a live timer so it never fires. It reports false without
// any effect when the handle is stale, already cancelled, or already fired.
func (c *Clock) Cancel(h Handle) bool {
	tm, ok := c.timers[h.ID]
	if !ok || tm.generation != h.Generation {
		return false
	}
	delete(c.timers, h.ID)
	c.record(Event{Tick: c.now, Kind: EventCancelled, Timer: h.ID, Deadline: tm.deadline})
	return true
}

// popDue removes and returns the earliest live entry due at or before
// limit, discarding stale heap entries left behind by rescheduling and
// cancellation.
func (c *Clock) popDue(limit uint64) (entry, bool) {
	for len(c.pending) > 0 {
		top := c.pending[0]
		tm, alive := c.timers[top.id]
		if !alive || tm.generation != top.generation {
			heap.Pop(&c.pending)
			continue
		}
		if top.deadline > limit {
			return entry{}, false
		}
		heap.Pop(&c.pending)
		return top, true
	}
	return entry{}, false
}

// hasDue reports whether any live timer is due at or before limit.
func (c *Clock) hasDue(limit uint64) bool {
	for len(c.pending) > 0 {
		top := c.pending[0]
		tm, alive := c.timers[top.id]
		if !alive || tm.generation != top.generation {
			heap.Pop(&c.pending)
			continue
		}
		return top.deadline <= limit
	}
	return false
}

// AdvanceTo moves the logical clock forward to tick t, firing every timer
// due at or before t in (deadline, ID) order. Before each timer fires the
// clock is positioned at that timer's deadline, so callbacks observe Now as
// their own due tick and may register follow-up timers due at the current
// tick; those join the end of the current round.
//
// At most Budget callbacks run per call. AdvanceTo returns the number of
// callbacks it ran and whether it stopped early because the budget was
// exhausted while more timers were still due; in that case the clock is
// left at the last fired timer's tick and a further AdvanceTo (to the same
// or a later tick) resumes firing. When nothing remains due, the clock
// settles at t.
//
// Advancing to a tick before Now panics.
func (c *Clock) AdvanceTo(t uint64) (fired int, exhausted bool) {
	if t < c.now {
		panic("timer: AdvanceTo cannot move the clock backward")
	}
	for fired < c.budget {
		e, ok := c.popDue(t)
		if !ok {
			c.now = t
			return fired, false
		}
		tm := c.timers[e.id]
		delete(c.timers, e.id)
		if e.deadline > c.now {
			c.now = e.deadline
		}
		c.record(Event{Tick: c.now, Kind: EventFired, Timer: e.id, Deadline: e.deadline})
		fired++
		tm.callback(c)
	}
	if c.hasDue(t) {
		return fired, true
	}
	c.now = t
	return fired, false
}
