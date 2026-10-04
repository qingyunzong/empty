// Package opctx provides an operation-context library: child contexts
// inherit their parent's deadline and may tighten it, parent cancellation
// propagates to the whole subtree exactly once, child cancellation never
// affects siblings, and cancellation callbacks registered via OnCancel are
// never missed even when registration races with cancellation.
package opctx

import (
	"container/heap"
	"sync"
	"time"
)

// Clock abstracts time so contexts can be driven by virtual time in tests.
type Clock interface {
	Now() time.Time
	// AfterFunc schedules fn to run when the clock reaches at.
	AfterFunc(at time.Time, fn func()) Timer
}

// Timer is a scheduled callback that can be stopped before it fires.
type Timer interface {
	// Stop reports whether the timer was still pending.
	Stop() bool
}

// RealClock backs contexts with the wall clock.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

func (RealClock) AfterFunc(at time.Time, fn func()) Timer {
	return realTimer{t: time.AfterFunc(time.Until(at), fn)}
}

type realTimer struct{ t *time.Timer }

func (r realTimer) Stop() bool { return r.t.Stop() }

// VirtualClock is a manually advanced Clock for deterministic tests.
// Scheduled functions run synchronously from Advance/AdvanceTo, in
// (time, registration) order.
type VirtualClock struct {
	mu  sync.Mutex
	now time.Time
	seq uint64
	evs eventHeap
}

func NewVirtualClock(start time.Time) *VirtualClock {
	return &VirtualClock{now: start}
}

func (c *VirtualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *VirtualClock) AfterFunc(at time.Time, fn func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seq++
	ev := &virtualEvent{at: at, seq: c.seq, fn: fn, active: true}
	heap.Push(&c.evs, ev)
	return &virtualTimer{clk: c, ev: ev}
}

// Advance moves the clock forward by d, firing due events.
func (c *VirtualClock) Advance(d time.Duration) { c.AdvanceTo(c.Now().Add(d)) }

// AdvanceTo moves the clock forward to t, firing every event scheduled at
// or before t in (time, registration) order. Events scheduled by fired
// callbacks are processed in the same pass if they fall within the window.
func (c *VirtualClock) AdvanceTo(t time.Time) {
	for {
		c.mu.Lock()
		if len(c.evs) == 0 || c.evs[0].at.After(t) {
			if t.After(c.now) {
				c.now = t
			}
			c.mu.Unlock()
			return
		}
		ev := heap.Pop(&c.evs).(*virtualEvent)
		active := ev.active
		if active && ev.at.After(c.now) {
			c.now = ev.at
		}
		c.mu.Unlock()
		if active {
			ev.fn()
		}
	}
}

// Pending reports how many scheduled events are still active (not fired,
// not stopped). After a full Release of a context tree it must be zero.
func (c *VirtualClock) Pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, ev := range c.evs {
		if ev.active {
			n++
		}
	}
	return n
}

type virtualEvent struct {
	at     time.Time
	seq    uint64
	fn     func()
	active bool
}

type virtualTimer struct {
	clk *VirtualClock
	ev  *virtualEvent
}

func (t *virtualTimer) Stop() bool {
	t.clk.mu.Lock()
	defer t.clk.mu.Unlock()
	if !t.ev.active {
		return false
	}
	t.ev.active = false
	return true
}

type eventHeap []*virtualEvent

func (h eventHeap) Len() int { return len(h) }

func (h eventHeap) Less(i, j int) bool {
	if h[i].at.Equal(h[j].at) {
		return h[i].seq < h[j].seq
	}
	return h[i].at.Before(h[j].at)
}

func (h eventHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }

func (h *eventHeap) Push(x any) { *h = append(*h, x.(*virtualEvent)) }

func (h *eventHeap) Pop() any {
	old := *h
	n := len(old)
	ev := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return ev
}
