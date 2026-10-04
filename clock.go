package ctxlib

import (
	"sync"
	"time"
)

// Timer is a scheduled callback that can be stopped.
type Timer interface {
	// Stop prevents the callback from running and reports whether it was
	// stopped before firing.
	Stop() bool
}

// Clock abstracts time so tests can drive cancellation deterministically.
type Clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) Timer
}

// RealClock is the wall clock.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

func (RealClock) AfterFunc(d time.Duration, f func()) Timer {
	return time.AfterFunc(d, f)
}

// VirtualClock is a manually advanced clock. Timers fire synchronously, in
// deadline order (ties broken by registration order), during Advance.
type VirtualClock struct {
	mu     sync.Mutex
	now    time.Time
	nextID int
	timers []*virtualTimer
}

type virtualTimer struct {
	clock   *VirtualClock
	id      int
	at      time.Time
	f       func()
	fired   bool
	stopped bool
}

func NewVirtualClock(start time.Time) *VirtualClock {
	return &VirtualClock{now: start}
}

func (c *VirtualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *VirtualClock) AfterFunc(d time.Duration, f func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &virtualTimer{clock: c, id: c.nextID, at: c.now.Add(d), f: f}
	c.nextID++
	c.timers = append(c.timers, t)
	return t
}

// Advance moves the clock forward by d, firing every timer scheduled at or
// before the target time. Timers registered by firing callbacks are also
// processed if they fall within the window.
func (c *VirtualClock) Advance(d time.Duration) {
	c.AdvanceTo(c.Now().Add(d))
}

// AdvanceTo moves the clock forward to the given instant.
func (c *VirtualClock) AdvanceTo(target time.Time) {
	for {
		c.mu.Lock()
		var next *virtualTimer
		for _, t := range c.timers {
			if t.stopped || t.fired || t.at.After(target) {
				continue
			}
			if next == nil || t.at.Before(next.at) || (t.at.Equal(next.at) && t.id < next.id) {
				next = t
			}
		}
		if next == nil {
			c.now = target
			c.mu.Unlock()
			return
		}
		next.fired = true
		c.now = next.at
		c.mu.Unlock()
		next.f()
	}
}

func (t *virtualTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	if t.fired || t.stopped {
		return false
	}
	t.stopped = true
	return true
}
