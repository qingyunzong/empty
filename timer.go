// Package timer implements a deterministic timer library driven by a
// controllable integer clock. Time only moves when Clock.Advance is
// called, which makes scheduling behavior fully reproducible in tests.
//
// Semantics:
//   - Reset creates a new generation for the timer. Any event enqueued
//     by an older generation is masked (skipped) when it reaches the
//     front of the queue, even if it was already enqueued.
//   - Events due at the same tick fire in creation order (the order in
//     which AfterFunc/Reset scheduled them).
//   - Callbacks run while the clock is at the event's deadline and may
//     Stop or Reset any timer, including themselves. An event scheduled
//     from a callback with delay 0 fires within the same Advance call.
package timer

import "container/heap"

// Clock is a controllable integer clock that owns a set of timers.
type Clock struct {
	now    int64
	seq    int64 // monotonically increasing creation-order counter
	events eventHeap
}

// event is one scheduled invocation of a timer.
type event struct {
	deadline  int64
	seq       int64 // creation order, breaks deadline ties
	gen       uint64
	timer     *Timer
	cancelled bool
	index     int
}

// Timer is a handle to a callback scheduled on a Clock.
type Timer struct {
	clock *Clock
	fn    func()
	gen   uint64 // current generation; bumped by Reset
	cur   *event // pending event, nil when not scheduled
}

// NewClock returns a Clock whose current time is 0.
func NewClock() *Clock { return &Clock{} }

// Now reports the clock's current time.
func (c *Clock) Now() int64 { return c.now }

// AfterFunc schedules fn to run d ticks from now and returns its Timer.
// d may be 0, in which case fn runs on the next Advance (including
// Advance(0)).
func (c *Clock) AfterFunc(d int64, fn func()) *Timer {
	t := &Timer{clock: c, fn: fn}
	t.schedule(d)
	return t
}

// Stop cancels the timer's pending event, if any. It reports whether a
// pending event was actually cancelled.
func (t *Timer) Stop() bool {
	if t.cur == nil {
		return false
	}
	t.cur.cancelled = true
	t.cur = nil
	return true
}

// Reset cancels any pending event, starts a new generation, and
// reschedules the callback d ticks from now. Events enqueued by older
// generations remain in the queue but are masked when reached.
func (t *Timer) Reset(d int64) {
	if t.cur != nil {
		t.cur.cancelled = true
		t.cur = nil
	}
	t.gen++
	t.schedule(d)
}

func (t *Timer) schedule(d int64) {
	if d < 0 {
		panic("timer: negative delay")
	}
	c := t.clock
	ev := &event{
		deadline: c.now + d,
		seq:      c.seq,
		gen:      t.gen,
		timer:    t,
	}
	c.seq++
	heap.Push(&c.events, ev)
	t.cur = ev
}

// Advance moves the clock forward by n ticks, firing every event whose
// deadline falls at or before the new time. Events fire in
// (deadline, creation-order) order. Stale events from older generations
// are discarded without running their callbacks. The clock is left at
// now+n even if the last event fired earlier.
func (c *Clock) Advance(n int64) {
	if n < 0 {
		panic("timer: negative advance")
	}
	target := c.now + n
	for len(c.events) > 0 && c.events[0].deadline <= target {
		ev := heap.Pop(&c.events).(*event)
		c.now = ev.deadline
		if ev.cancelled || ev.gen != ev.timer.gen || ev.timer.cur != ev {
			continue // masked: stopped or superseded by a newer generation
		}
		ev.timer.cur = nil
		ev.timer.fn()
	}
	c.now = target
}

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
	*h = old[:n-1]
	return ev
}
