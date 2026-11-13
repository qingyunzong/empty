package dataeng

import (
	"sync"
	"time"
)

// Clock abstracts time so the scheduler can be driven deterministically
// in tests. Use NewManualClock for tests; pass nil to NewScheduler to use
// the real wall clock.
type Clock interface {
	Now() time.Time
	Timer(d time.Duration) Timer
}

// Timer is a single-fire countdown. C fires at most once.
type Timer interface {
	C() <-chan time.Time
	Stop() bool
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (realClock) Timer(d time.Duration) Timer {
	if d < 0 {
		d = 0
	}
	return realTimer{t: time.NewTimer(d)}
}

type realTimer struct{ t *time.Timer }

func (r realTimer) C() <-chan time.Time { return r.t.C }
func (r realTimer) Stop() bool          { return r.t.Stop() }

// ManualClock is a deterministic Clock for tests. Time only moves when
// Advance is called, which fires any timers whose deadline has passed.
type ManualClock struct {
	mu     sync.Mutex
	now    time.Time
	timers map[*manualTimer]struct{}
}

// NewManualClock returns a ManualClock set to start.
func NewManualClock(start time.Time) *ManualClock {
	return &ManualClock{now: start, timers: make(map[*manualTimer]struct{})}
}

// Now returns the clock's current time.
func (c *ManualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Timer returns a Timer that fires when the clock reaches now+d.
func (c *ManualClock) Timer(d time.Duration) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &manualTimer{clock: c, deadline: c.now.Add(d), ch: make(chan time.Time, 1)}
	if d <= 0 {
		t.ch <- c.now
		return t
	}
	c.timers[t] = struct{}{}
	return t
}

// Advance moves the clock forward by d, firing expired timers.
func (c *ManualClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	for t := range c.timers {
		if !t.deadline.After(c.now) {
			delete(c.timers, t)
			t.ch <- c.now
		}
	}
}

type manualTimer struct {
	clock    *ManualClock
	deadline time.Time
	ch       chan time.Time
}

func (t *manualTimer) C() <-chan time.Time { return t.ch }

func (t *manualTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	_, active := t.clock.timers[t]
	delete(t.clock.timers, t)
	return active
}
