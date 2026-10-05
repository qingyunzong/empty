package clocksim

import "sync"

// ManualClock is a virtual clock advanced only by explicit ticks. Each tick
// moves the window forward by step, unless the clock is stalled, in which
// case a tick makes no progress.
type ManualClock struct {
	mu      sync.Mutex
	now     int64
	step    int64
	unc     int64 // uncertainty width: Latest = now + unc
	stalled bool
	ticks   uint64
}

// NewManualClock creates a clock starting at start, advancing step per tick,
// with an uncertainty width of unc.
func NewManualClock(start, step, unc int64) *ManualClock {
	return &ManualClock{now: start, step: step, unc: unc}
}

// Now returns the current uncertainty interval.
func (c *ManualClock) Now() Interval {
	c.mu.Lock()
	defer c.mu.Unlock()
	return Interval{Earliest: c.now, Latest: c.now + c.unc}
}

// Tick advances the clock by one virtual tick. It returns the interval after
// the tick and whether the interval made progress.
func (c *ManualClock) Tick() (Interval, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	before := Interval{Earliest: c.now, Latest: c.now + c.unc}
	if !c.stalled {
		c.now += c.step
	}
	c.ticks++
	after := Interval{Earliest: c.now, Latest: c.now + c.unc}
	return after, after != before
}

// Stall freezes the clock: subsequent ticks make no progress.
func (c *ManualClock) Stall() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stalled = true
}

// Resume unfreezes the clock.
func (c *ManualClock) Resume() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stalled = false
}

// Ticks returns how many ticks have been issued.
func (c *ManualClock) Ticks() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ticks
}
