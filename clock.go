package dataeng

import (
	"sync"
	"time"
)

// Timer is the subset of time.Timer used by the scheduler.
type Timer interface {
	Stop() bool
}

// Clock supplies time and one-shot callbacks. The scheduler never starts a
// background goroutine of its own; a real clock calls callbacks from a
// time.AfterFunc goroutine, while ManualClock calls them synchronously.
type Clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) Timer
}

// SystemClock is the production Clock implementation.
type SystemClock struct{}

func (SystemClock) Now() time.Time { return time.Now() }

func (SystemClock) AfterFunc(d time.Duration, f func()) Timer {
	if d < time.Nanosecond {
		d = time.Nanosecond
	}
	return &systemTimer{timer: time.AfterFunc(d, f)}
}

type systemTimer struct {
	timer *time.Timer
}

func (t *systemTimer) Stop() bool { return t.timer.Stop() }

// ManualClock is a deterministic virtual clock for tests and simulations.
//
// Advancing the clock fires due callbacks in chronological order. Callbacks
// run synchronously with the clock unlocked, so a callback may schedule new
// timers and Advance will observe them before it reaches the target time.
type ManualClock struct {
	advanceMu sync.Mutex
	mu        sync.Mutex
	now       time.Time
	seq       uint64
	timers    []*manualTimer
}

type manualTimer struct {
	clock   *ManualClock
	due     time.Time
	fn      func()
	seq     uint64
	stopped bool
	fired   bool
}

// NewManualClock returns a clock positioned at start. A zero start is
// replaced with the Unix epoch.
func NewManualClock(start time.Time) *ManualClock {
	if start.IsZero() {
		start = time.Unix(0, 0).UTC()
	}
	return &ManualClock{now: start}
}

func (c *ManualClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *ManualClock) AfterFunc(d time.Duration, f func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	if d < 0 {
		d = 0
	}
	t := &manualTimer{
		clock: c,
		due:   c.now.Add(d),
		fn:    f,
		seq:   c.seq,
	}
	c.seq++
	c.timers = append(c.timers, t)
	return t
}

func (t *manualTimer) Stop() bool {
	c := t.clock
	c.mu.Lock()
	defer c.mu.Unlock()
	if t.stopped || t.fired {
		return false
	}
	t.stopped = true
	return true
}

// Advance moves the clock forward by d, firing every due callback in order.
// It panics for a negative duration. Advance calls must not be concurrent.
func (c *ManualClock) Advance(d time.Duration) {
	if d < 0 {
		panic("dataeng: negative ManualClock advance")
	}
	c.advanceMu.Lock()
	defer c.advanceMu.Unlock()

	c.mu.Lock()
	target := c.now.Add(d)
	c.mu.Unlock()

	for {
		c.mu.Lock()
		var next *manualTimer
		nextIndex := -1
		for i, t := range c.timers {
			if t.stopped || t.fired || t.due.After(target) {
				continue
			}
			if next == nil || t.due.Before(next.due) || (t.due.Equal(next.due) && t.seq < next.seq) {
				next = t
				nextIndex = i
			}
		}
		if next == nil {
			c.now = target
			c.compactLocked()
			c.mu.Unlock()
			return
		}
		c.now = next.due
		next.fired = true
		c.timers = append(c.timers[:nextIndex], c.timers[nextIndex+1:]...)
		c.mu.Unlock()
		next.fn()
	}
}

// Timers reports the number of callbacks that have neither fired nor been
// stopped.
func (c *ManualClock) Timers() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, t := range c.timers {
		if !t.stopped && !t.fired {
			n++
		}
	}
	return n
}

func (c *ManualClock) compactLocked() {
	n := 0
	for _, t := range c.timers {
		if !t.stopped && !t.fired {
			c.timers[n] = t
			n++
		}
	}
	c.timers = c.timers[:n]
}
