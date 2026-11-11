package q149

import "time"

// Clock abstracts time acquisition so that freshness and revalidation
// behavior can be exercised deterministically in tests.
type Clock interface {
	Now() time.Time
}

// SystemClock reports the current wall-clock time.
type SystemClock struct{}

// Now returns time.Now.
func (SystemClock) Now() time.Time { return time.Now() }

// FakeClock is a manually controlled Clock intended for tests.
type FakeClock struct {
	now time.Time
}

// NewFakeClock returns a FakeClock initialized at t.
func NewFakeClock(t time.Time) *FakeClock {
	return &FakeClock{now: t}
}

// Now returns the currently staged time.
func (c *FakeClock) Now() time.Time { return c.now }

// Advance moves the staged time forward by d.
func (c *FakeClock) Advance(d time.Duration) { c.now = c.now.Add(d) }

// Set moves the staged time to t.
func (c *FakeClock) Set(t time.Time) { c.now = t }
