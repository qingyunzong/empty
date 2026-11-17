package formal

import (
	"sync"
	"time"
)

// Clock supplies the collector's notion of the current time.
//
// Production code can use RealClock. Tests should use ManualClock so that
// deadlines and late-arrival windows are deterministic.
type Clock interface {
	Now() time.Time
}

// RealClock is a Clock backed by time.Now.
type RealClock struct{}

// Now implements Clock.
func (RealClock) Now() time.Time {
	return time.Now()
}

// ManualClock is a virtual clock. It is safe for concurrent use.
type ManualClock struct {
	mu  sync.Mutex
	now time.Time
}

// NewManualClock creates a virtual clock positioned at start.
func NewManualClock(start time.Time) *ManualClock {
	return &ManualClock{now: start}
}

// Now implements Clock.
func (c *ManualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Advance moves the clock forward by d and returns the new time.
//
// Advancing by a negative duration is a programming error and panics.
func (c *ManualClock) Advance(d time.Duration) time.Time {
	if d < 0 {
		panic("formal: manual clock cannot move backwards")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
	return c.now
}

// Set positions the clock at t. It is intended for test setup only.
func (c *ManualClock) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = t
}
