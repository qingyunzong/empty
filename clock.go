package dataeng

import "time"

// Clock supplies processing time for emitted records. It is deliberately
// separate from event time and from the external watermark.
type Clock interface {
	Now() time.Time
}

// ClockFunc adapts a function to a Clock.
type ClockFunc func() time.Time

// Now calls f.
func (f ClockFunc) Now() time.Time {
	return f()
}
