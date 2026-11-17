package formal

import "time"

// Clock supplies the local time used by a Machine. Implementations must be
// monotonic for the lifetime of a leader term; wall-clock steps are outside
// the protocol's assumptions.
type Clock interface {
	Now() time.Time
}

// ClockFunc adapts a function to Clock.
type ClockFunc func() time.Time

// Now implements Clock.
func (f ClockFunc) Now() time.Time { return f() }

// SystemClock is a Clock backed by time.Now.
type SystemClock struct{}

// Now implements Clock.
func (SystemClock) Now() time.Time { return time.Now() }
