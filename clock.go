package dataeng

import "time"

// Clock supplies wall-clock and monotonic readings. The real clock is used
// by default; tests substitute a virtual clock.
type Clock interface {
	// Now returns the current wall-clock time.
	Now() time.Time
	// Monotonic returns a monotonic reading comparable only with other
	// readings from the same Clock.
	Monotonic() time.Duration
}

type realClock struct {
	start time.Time
}

func (c realClock) Now() time.Time { return time.Now() }

func (c realClock) Monotonic() time.Duration { return time.Since(c.start) }
