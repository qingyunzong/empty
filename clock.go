package formal

import (
	"sync"
	"time"
)

// Timer is the subset of time.Timer needed by Coordinator.
type Timer interface {
	Stop() bool
}

// Clock abstracts time so lease expiry can be controlled deterministically in
// tests.
type Clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) Timer
}

// SystemClock is the wall-clock implementation of Clock.
type SystemClock struct{}

func (SystemClock) Now() time.Time {
	return time.Now()
}

func (SystemClock) AfterFunc(d time.Duration, f func()) Timer {
	return time.AfterFunc(d, f)
}

// FakeClock is a manually advanced Clock. Its zero value is not usable; call
// NewFakeClock.
type FakeClock struct {
	mu     sync.Mutex
	now    time.Time
	nextID uint64
	timers []*fakeTimer
}

type fakeTimer struct {
	clock   *FakeClock
	when    time.Time
	order   uint64
	fn      func()
	stopped bool
}

// NewFakeClock returns a fake clock starting at the Unix epoch.
func NewFakeClock() *FakeClock {
	return NewFakeClockAt(time.Unix(0, 0))
}

// NewFakeClockAt returns a fake clock starting at start.
func NewFakeClockAt(start time.Time) *FakeClock {
	return &FakeClock{now: start}
}

// Now returns the current fake time.
func (c *FakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// AfterFunc schedules f after d. The callback runs on Advance.
func (c *FakeClock) AfterFunc(d time.Duration, f func()) Timer {
	if d < 0 {
		d = 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	t := &fakeTimer{
		clock: c,
		when:  c.now.Add(d),
		order: c.nextID,
		fn:    f,
	}
	c.timers = append(c.timers, t)
	return t
}

// Stop cancels the timer. It reports whether the timer was still pending.
func (t *fakeTimer) Stop() bool {
	c := t.clock
	c.mu.Lock()
	defer c.mu.Unlock()
	if t.stopped {
		return false
	}
	t.stopped = true
	for i, other := range c.timers {
		if other == t {
			c.timers = append(c.timers[:i], c.timers[i+1:]...)
			break
		}
	}
	return true
}

// Advance moves fake time forward, firing due timers in deadline order. A
// callback that schedules another due timer will run before Advance returns.
func (c *FakeClock) Advance(d time.Duration) {
	if d < 0 {
		panic("formal: cannot advance a fake clock backwards")
	}

	c.mu.Lock()
	target := c.now.Add(d)
	c.mu.Unlock()

	for {
		c.mu.Lock()
		var next *fakeTimer
		for _, t := range c.timers {
			if t.stopped || t.when.After(target) {
				continue
			}
			if next == nil || t.when.Before(next.when) ||
				(t.when.Equal(next.when) && t.order < next.order) {
				next = t
			}
		}
		if next == nil {
			if c.now.Before(target) {
				c.now = target
			}
			c.mu.Unlock()
			return
		}

		if next.when.After(c.now) {
			c.now = next.when
		}
		next.stopped = true
		for i, t := range c.timers {
			if t == next {
				c.timers = append(c.timers[:i], c.timers[i+1:]...)
				break
			}
		}
		fn := next.fn
		c.mu.Unlock()

		fn()
	}
}

// Timers returns the number of pending timers. It is primarily useful in
// tests that check timers are not leaked.
func (c *FakeClock) Timers() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, t := range c.timers {
		if !t.stopped {
			n++
		}
	}
	return n
}
