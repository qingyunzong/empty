package readroute

import (
	"sync"
	"time"
)

// Clock abstracts time so the router can be driven by a virtual clock in tests.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
}

// RealClock delegates to the time package.
type RealClock struct{}

func (RealClock) Now() time.Time                         { return time.Now() }
func (RealClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

type virtualTimer struct {
	deadline time.Time
	ch       chan time.Time
	fired    bool
}

// VirtualClock is a manually advanced Clock. Timers fire only when Advance
// moves the clock past their deadline, so tests never sleep in real time.
type VirtualClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*virtualTimer
}

func NewVirtualClock(start time.Time) *VirtualClock {
	return &VirtualClock{now: start}
}

func (c *VirtualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *VirtualClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &virtualTimer{deadline: c.now.Add(d), ch: make(chan time.Time, 1)}
	if d <= 0 {
		t.fired = true
		t.ch <- c.now
		return t.ch
	}
	c.timers = append(c.timers, t)
	return t.ch
}

// Advance moves the clock forward by d, firing every timer whose deadline
// has been reached, in deadline order.
func (c *VirtualClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	remaining := c.timers[:0]
	for _, t := range c.timers {
		if !t.fired && !t.deadline.After(c.now) {
			t.fired = true
			t.ch <- c.now
		} else {
			remaining = append(remaining, t)
		}
	}
	c.timers = remaining
}
