package aggregator

import (
	"container/heap"
	"sync"
	"time"
)

// VirtualClock is a manually advanced clock. Timers fire only when the
// clock is advanced past their deadline, which makes timeout behavior
// deterministic in tests.
type VirtualClock struct {
	mu     sync.Mutex
	now    time.Time
	seq    int
	timers timerHeap
}

// NewVirtualClock returns a VirtualClock starting at start.
func NewVirtualClock(start time.Time) *VirtualClock {
	return &VirtualClock{now: start}
}

// Now reports the current virtual time.
func (c *VirtualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Timer is a handle to a callback scheduled on a VirtualClock.
type Timer struct {
	clock    *VirtualClock
	deadline time.Time
	seq      int
	f        func()
	stopped  bool
}

// AfterFunc schedules f to run when the virtual clock reaches now+d.
// The callback runs on the goroutine that advances the clock.
func (c *VirtualClock) AfterFunc(d time.Duration, f func()) *Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &Timer{clock: c, deadline: c.now.Add(d), seq: c.seq, f: f}
	c.seq++
	heap.Push(&c.timers, t)
	return t
}

// Stop prevents the timer from firing. It reports whether the timer was
// still pending.
func (t *Timer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	if t.stopped {
		return false
	}
	t.stopped = true
	return true
}

// Advance moves the virtual clock forward by d and fires every timer
// whose deadline has passed, in deadline order. Callbacks run without
// the clock lock held, so they may schedule new timers.
func (c *VirtualClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	var fired []*Timer
	for len(c.timers) > 0 && !c.timers[0].deadline.After(c.now) {
		t := heap.Pop(&c.timers).(*Timer)
		if !t.stopped {
			fired = append(fired, t)
		}
	}
	c.mu.Unlock()
	for _, t := range fired {
		t.f()
	}
}

// timerHeap is a min-heap of timers ordered by deadline, then by
// insertion sequence so equal deadlines fire in scheduling order.
type timerHeap []*Timer

func (h timerHeap) Len() int { return len(h) }

func (h timerHeap) Less(i, j int) bool {
	if h[i].deadline.Equal(h[j].deadline) {
		return h[i].seq < h[j].seq
	}
	return h[i].deadline.Before(h[j].deadline)
}

func (h timerHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }

func (h *timerHeap) Push(x any) { *h = append(*h, x.(*Timer)) }

func (h *timerHeap) Pop() any {
	old := *h
	n := len(old)
	t := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return t
}
