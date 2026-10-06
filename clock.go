package readwait

import (
	"sort"
	"sync"
	"time"
)

// Clock abstracts time so timeout events are controllable in tests.
type Clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) Timer
}

// Timer is a scheduled callback that can be stopped before it fires.
type Timer interface {
	Stop() bool
}

// RealClock backs Clock with standard library timers.
type RealClock struct{}

// Now returns the current wall-clock time.
func (RealClock) Now() time.Time { return time.Now() }

// AfterFunc schedules f to run after d.
func (RealClock) AfterFunc(d time.Duration, f func()) Timer {
	return &realTimer{timer: time.AfterFunc(d, f)}
}

type realTimer struct{ timer *time.Timer }

func (t *realTimer) Stop() bool { return t.timer.Stop() }

// ManualClock is a deterministic Clock for tests: timers fire only when
// Advance moves the clock past their deadline, making timeout events fully
// controllable.
type ManualClock struct {
	mu     sync.Mutex
	now    time.Time
	seq    int
	timers map[*manualTimer]struct{}
}

// NewManualClock returns a ManualClock starting at start.
func NewManualClock(start time.Time) *ManualClock {
	return &ManualClock{now: start, timers: make(map[*manualTimer]struct{})}
}

// Now returns the clock's current time.
func (c *ManualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// AfterFunc schedules f to fire when the clock reaches now+d.
func (c *ManualClock) AfterFunc(d time.Duration, f func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &manualTimer{
		clock:    c,
		deadline: c.now.Add(d),
		seq:      c.seq,
		f:        f,
	}
	c.seq++
	c.timers[t] = struct{}{}
	return t
}

// Advance moves the clock forward by d and fires every timer whose deadline
// has passed, in deadline order. Callbacks run synchronously before Advance
// returns, so their effects are visible to the caller immediately.
func (c *ManualClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	for {
		var expired []*manualTimer
		for t := range c.timers {
			if !t.deadline.After(c.now) {
				expired = append(expired, t)
			}
		}
		if len(expired) == 0 {
			c.mu.Unlock()
			return
		}
		sort.Slice(expired, func(i, j int) bool {
			if expired[i].deadline.Equal(expired[j].deadline) {
				return expired[i].seq < expired[j].seq
			}
			return expired[i].deadline.Before(expired[j].deadline)
		})
		for _, t := range expired {
			delete(c.timers, t)
		}
		c.mu.Unlock()
		for _, t := range expired {
			t.f()
		}
		c.mu.Lock()
	}
}

type manualTimer struct {
	clock    *ManualClock
	deadline time.Time
	seq      int
	f        func()
}

func (t *manualTimer) Stop() bool {
	t.clock.mu.Lock()
	defer t.clock.mu.Unlock()
	if _, ok := t.clock.timers[t]; !ok {
		return false
	}
	delete(t.clock.timers, t)
	return true
}
