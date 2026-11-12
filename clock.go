package dataeng

import (
	"container/heap"
	"sync"
	"time"
)

// Timer is the timer abstraction used by the scheduler. It mirrors
// time.Timer: C receives one value after the configured duration, Stop
// prevents the timer from firing, and Reset re-arms it.
type Timer interface {
	C() <-chan time.Time
	Stop() bool
	Reset(d time.Duration) bool
}

// Clock is the injectable time source. Implementations must be safe for
// concurrent use.
type Clock interface {
	Now() time.Time
	NewTimer(d time.Duration) Timer
}

// RealClock is backed by the process monotonic clock.
type RealClock struct{}

// NewRealClock returns a Clock backed by time.Now / time.NewTimer.
func NewRealClock() RealClock { return RealClock{} }

func (RealClock) Now() time.Time { return time.Now() }

func (RealClock) NewTimer(d time.Duration) Timer {
	return &realTimer{t: time.NewTimer(d)}
}

type realTimer struct{ t *time.Timer }

func (r *realTimer) C() <-chan time.Time { return r.t.C }

func (r *realTimer) Stop() bool { return r.t.Stop() }

func (r *realTimer) Reset(d time.Duration) bool {
	if !r.t.Stop() {
		select {
		case <-r.t.C:
		default:
		}
	}
	r.t.Reset(d)
	return true
}

// FakeClock is a manually advanced, deterministic clock for tests. Timers
// only fire when the clock is Advanced past their deadline. The zero value is
// not usable; construct one with NewFakeClock.
type FakeClock struct {
	mu      sync.Mutex
	now     time.Time
	timers  fakeTimerHeap
	counter int64
}

// NewFakeClock returns a FakeClock initialized at start.
func NewFakeClock(start time.Time) *FakeClock {
	return &FakeClock{now: start}
}

// Now returns the current fake time.
func (c *FakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// NewTimer creates a timer that fires d fake-time units from now.
func (c *FakeClock) NewTimer(d time.Duration) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.counter++
	t := &fakeTimer{
		clock: c,
		ch:    make(chan time.Time, 1),
		fire:  c.now.Add(d),
		seq:   c.counter,
	}
	heap.Push(&c.timers, t)
	return t
}

// Advance moves the clock forward by d, firing every due timer (in deadline
// order) before returning. Fires are non-blocking channel sends, so callers
// must select on timer channels between Advance calls as normal.
func (c *FakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	for c.timers.Len() > 0 && !c.timers[0].fire.After(c.now) {
		t := heap.Pop(&c.timers).(*fakeTimer)
		t.stopped = true
		select {
		case t.ch <- t.fire:
		default:
		}
	}
	c.mu.Unlock()
}

type fakeTimer struct {
	clock   *FakeClock
	ch      chan time.Time
	fire    time.Time
	seq     int64
	stopped bool
	index   int
}

func (t *fakeTimer) C() <-chan time.Time { return t.ch }

func (t *fakeTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	active := !t.stopped
	if active {
		heap.Remove(&t.clock.timers, t.index)
		t.stopped = true
		// Release any goroutine waiting on C without delivering a tick.
		close(t.ch)
	}
	return active
}

func (t *fakeTimer) Reset(d time.Duration) bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	active := !t.stopped
	if active {
		heap.Remove(&t.clock.timers, t.index)
	}
	if t.stopped {
		t.ch = make(chan time.Time, 1)
	}
	t.clock.counter++
	t.seq = t.clock.counter
	t.fire = t.clock.now.Add(d)
	t.stopped = false
	heap.Push(&t.clock.timers, t)
	return active
}

type fakeTimerHeap []*fakeTimer

func (h fakeTimerHeap) Len() int { return len(h) }

func (h fakeTimerHeap) Less(i, j int) bool {
	if !h[i].fire.Equal(h[j].fire) {
		return h[i].fire.Before(h[j].fire)
	}
	return h[i].seq < h[j].seq
}

func (h fakeTimerHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index = i
	h[j].index = j
}

func (h *fakeTimerHeap) Push(x any) {
	t := x.(*fakeTimer)
	t.index = len(*h)
	*h = append(*h, t)
}

func (h *fakeTimerHeap) Pop() any {
	old := *h
	n := len(old)
	t := old[n-1]
	t.index = -1
	*h = old[:n-1]
	return t
}
