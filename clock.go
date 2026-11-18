package formal

import (
	"sync"
	"time"
)

// Clock is the time source used by a Scheduler. Tests and simulations can
// provide a manual clock; production callers normally use SystemClock.
type Clock interface {
	Now() time.Time
}

// SystemClock is a Clock backed by the wall clock.
type SystemClock struct{}

// Now returns the current wall-clock time.
func (SystemClock) Now() time.Time { return time.Now() }

// ManualClock is a deterministic Clock for tests and simulations.
type ManualClock struct {
	mu  sync.RWMutex
	now time.Time
}

// NewManualClock returns a manual clock initialized to now.
func NewManualClock(now time.Time) *ManualClock {
	return &ManualClock{now: now}
}

// Now returns the current virtual time.
func (c *ManualClock) Now() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.now
}

// Set moves the virtual clock to now. It does not move a Scheduler; call
// Scheduler.Advance or Scheduler.Poll to process due messages.
func (c *ManualClock) Set(now time.Time) {
	c.mu.Lock()
	c.now = now
	c.mu.Unlock()
}

// Advance moves the virtual clock forward by d and returns the new time.
func (c *ManualClock) Advance(d time.Duration) time.Time {
	c.mu.Lock()
	c.now = c.now.Add(d)
	now := c.now
	c.mu.Unlock()
	return now
}
