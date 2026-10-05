// Package timer implements a timer library driven by a controllable
// integer clock. Time only moves when the caller advances the clock,
// which makes behavior fully deterministic and easy to test.
//
// Semantics:
//   - Reset creates a new generation of the timer. Any event from an
//     older generation is masked, even if it is already enqueued.
//   - Events due at the same tick fire in creation (enqueue) order.
//   - A callback may Reset its own timer (or any other timer); the new
//     event is scheduled relative to the clock's current time.
package timer

import "container/heap"

// Clock is a manually advanced integer clock that fires timer events.
type Clock struct {
	now    int64
	seq    uint64 // global enqueue counter, defines creation order
	events eventHeap
}

// NewClock returns a Clock whose current time is start.
func NewClock(start int64) *Clock {
	return &Clock{now: start}
}

// Now reports the clock's current time.
func (c *Clock) Now() int64 { return c.now }

// Timer is a single scheduled callback. The zero value is not usable;
// obtain timers via Clock.AfterFunc. A Timer may be reused any number
// of times through Reset.
type Timer struct {
	clock  *Clock
	gen    uint64 // current generation; bumped by Reset and Stop
	active bool   // whether a live (unmasked) event is pending
	cb     func()
}

// event is one enqueued firing of a timer generation.
type event struct {
	deadline int64
	seq      uint64
	gen      uint64
	timer    *Timer
	index    int // position in the heap, maintained by container/heap
}

// AfterFunc schedules f to run d ticks from now and returns a Timer
// that can be used to stop or reschedule it. d may be zero, in which
// case f runs at the current tick the next time the clock is advanced
// (or immediately if called from within a callback during Advance).
func (c *Clock) AfterFunc(d int64, f func()) *Timer {
	t := &Timer{clock: c, cb: f}
	t.Reset(d)
	return t
}

// Stop prevents the timer from firing. It reports whether the call
// stopped a pending event; it returns false if the timer had already
// fired or was already stopped.
func (t *Timer) Stop() bool {
	if !t.active {
		return false
	}
	t.active = false
	t.gen++ // mask the enqueued event of the previous generation
	return true
}

// Reset reschedules the timer to fire d ticks from the clock's current
// time and returns true. Reset always creates a new generation: any
// previously enqueued event — including one due at the current tick —
// is masked and will never run.
func (t *Timer) Reset(d int64) bool {
	c := t.clock
	t.gen++
	t.active = true
	c.seq++
	heap.Push(&c.events, &event{
		deadline: c.now + d,
		seq:      c.seq,
		gen:      t.gen,
		timer:    t,
	})
	return true
}

// Advance moves the clock forward by delta ticks (delta must be
// non-negative) and fires every event that becomes due, in
// (deadline, creation-order) sequence. Before each callback runs, the
// clock's time is set to that event's deadline, so a callback that
// resets its own timer schedules relative to its own tick. Events
// enqueued by callbacks that fall due within the advanced window are
// fired within the same Advance call.
func (c *Clock) Advance(delta int64) {
	if delta < 0 {
		panic("timer: negative advance")
	}
	c.AdvanceTo(c.now + delta)
}

// AdvanceTo moves the clock forward to the absolute time target.
func (c *Clock) AdvanceTo(target int64) {
	if target < c.now {
		panic("timer: cannot move clock backwards")
	}
	for len(c.events) > 0 && c.events[0].deadline <= target {
		ev := heap.Pop(&c.events).(*event)
		c.now = ev.deadline
		t := ev.timer
		if !t.active || ev.gen != t.gen {
			continue // masked by Stop or Reset of a newer generation
		}
		t.active = false // consumed; the callback may Reset itself
		t.cb()
	}
	c.now = target
}

// Pending reports the number of enqueued events, including masked ones
// that have not yet been discarded by Advance.
func (c *Clock) Pending() int { return len(c.events) }

// eventHeap is a min-heap ordered by (deadline, seq).
type eventHeap []*event

func (h eventHeap) Len() int { return len(h) }

func (h eventHeap) Less(i, j int) bool {
	if h[i].deadline != h[j].deadline {
		return h[i].deadline < h[j].deadline
	}
	return h[i].seq < h[j].seq
}

func (h eventHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index = i
	h[j].index = j
}

func (h *eventHeap) Push(x any) {
	ev := x.(*event)
	ev.index = len(*h)
	*h = append(*h, ev)
}

func (h *eventHeap) Pop() any {
	old := *h
	n := len(old)
	ev := old[n-1]
	old[n-1] = nil
	ev.index = -1
	*h = old[:n-1]
	return ev
}
