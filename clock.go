package router

import (
	"sync"
	"time"
)

// Clock abstracts time so tests can simulate replica catch-up and
// revocation deterministically.
type Clock interface {
	Now() time.Time
	Sleep(d time.Duration)
}

// RealClock is the production Clock backed by the time package.
type RealClock struct{}

func (RealClock) Now() time.Time        { return time.Now() }
func (RealClock) Sleep(d time.Duration) { time.Sleep(d) }

// VirtualClock is a deterministic Clock for tests. Advancing the clock
// fires scheduled hooks, which tests use to simulate replicas catching
// up or being revoked while the router is waiting.
type VirtualClock struct {
	mu    sync.Mutex
	now   time.Time
	hooks []hook
}

type hook struct {
	at    time.Time
	fn    func(now time.Time)
	fired bool
}

func NewVirtualClock(start time.Time) *VirtualClock {
	return &VirtualClock{now: start}
}

func (c *VirtualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// Sleep advances the virtual clock; scheduled hooks fire as their
// scheduled time is reached.
func (c *VirtualClock) Sleep(d time.Duration) { c.Advance(d) }

// Advance moves the clock forward and fires any hooks scheduled at or
// before the new time, in scheduling order.
func (c *VirtualClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	now := c.now
	var due []func(time.Time)
	for i := range c.hooks {
		if !c.hooks[i].fired && !c.hooks[i].at.After(now) {
			c.hooks[i].fired = true
			due = append(due, c.hooks[i].fn)
		}
	}
	c.mu.Unlock()
	for _, fn := range due {
		fn(now)
	}
}

// At schedules fn to fire once when the clock reaches or passes t.
// If the clock has already passed t, fn fires immediately.
func (c *VirtualClock) At(t time.Time, fn func(now time.Time)) {
	c.mu.Lock()
	fireNow := !t.After(c.now)
	if !fireNow {
		c.hooks = append(c.hooks, hook{at: t, fn: fn})
	}
	c.mu.Unlock()
	if fireNow {
		fn(c.Now())
	}
}
