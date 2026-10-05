package ratelimit

import "sync"

// Clock is a manual virtual clock measured in integer ticks.
// The zero value is ready to use and starts at tick 0.
type Clock struct {
	mu  sync.Mutex
	now int64
}

// NewClock returns a Clock starting at the given tick.
func NewClock(start int64) *Clock {
	return &Clock{now: start}
}

// Now returns the current tick.
func (c *Clock) Now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Advance moves the clock forward by d ticks (d must be >= 0)
// and returns the new tick.
func (c *Clock) Advance(d int64) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if d < 0 {
		panic("ratelimit: cannot advance clock by a negative amount")
	}
	c.now += d
	return c.now
}
