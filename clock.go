package formal

import (
	"sync"
	"time"
)

// Clock is a virtual clock used to account for simulated upstream waits.
// Resolve advances the clock by the time actually spent on each attempt.
type Clock interface {
	Now() time.Time
	Advance(time.Duration)
}

// VirtualClock is a deterministic Clock implementation.
type VirtualClock struct {
	mu  sync.Mutex
	now time.Time
}

// NewVirtualClock returns a clock starting at start.
func NewVirtualClock(start time.Time) *VirtualClock {
	return &VirtualClock{now: start}
}

// Now implements Clock.
func (c *VirtualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Advance implements Clock.
func (c *VirtualClock) Advance(d time.Duration) {
	if d <= 0 {
		return
	}
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}
