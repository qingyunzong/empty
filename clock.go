package formal

import (
	"sync"
	"time"
)

// Clock supplies time to breakers. Production code normally uses RealClock;
// tests and simulations can use VirtualClock.
type Clock interface {
	Now() time.Time
}

// RealClock reads the wall clock.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

// VirtualClock is a concurrency-safe, manually advanced clock.
type VirtualClock struct {
	mu  sync.RWMutex
	now time.Time
}

// NewVirtualClock creates a clock at start.
func NewVirtualClock(start time.Time) *VirtualClock {
	return &VirtualClock{now: start}
}

func (c *VirtualClock) Now() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.now
}

// Advance moves the clock forward by d.
func (c *VirtualClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// Set moves the clock to t.
func (c *VirtualClock) Set(t time.Time) {
	c.mu.Lock()
	c.now = t
	c.mu.Unlock()
}
