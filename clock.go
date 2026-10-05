package aggregator

import (
	"sync"
	"time"
)

// Clock abstracts time so batch timeouts can be driven by virtual
// (manually advanced) time in tests.
type Clock interface {
	Now() time.Time
	NewTimer(d time.Duration) Timer
}

// Timer is a single-use countdown, mirroring time.Timer.
type Timer interface {
	C() <-chan time.Time
	Stop() bool
}

// RealClock implements Clock with the wall clock.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

func (RealClock) NewTimer(d time.Duration) Timer { return realTimer{time.NewTimer(d)} }

type realTimer struct{ t *time.Timer }

func (t realTimer) C() <-chan time.Time { return t.t.C }

func (t realTimer) Stop() bool { return t.t.Stop() }

// ManualClock is a virtual clock: time only moves when Advance is called,
// which fires every timer whose deadline has been reached.
type ManualClock struct {
	mu     sync.Mutex
	now    time.Time
	timers map[*manualTimer]struct{}
}

func NewManualClock(start time.Time) *ManualClock {
	return &ManualClock{now: start, timers: make(map[*manualTimer]struct{})}
}

func (c *ManualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *ManualClock) NewTimer(d time.Duration) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &manualTimer{clock: c, deadline: c.now.Add(d), ch: make(chan time.Time, 1)}
	c.timers[t] = struct{}{}
	return t
}

// Advance moves virtual time forward and fires all expired timers.
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
