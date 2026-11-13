package dataeng

import (
	"fmt"
	"time"
)

// Window is a half-open event-time interval [Start, End).
type Window struct {
	Start time.Time
	End   time.Time
}

// Duration returns End-Start.
func (w Window) Duration() time.Duration {
	return w.End.Sub(w.Start)
}

// Contains reports whether ts belongs to this window.
func (w Window) Contains(ts time.Time) bool {
	return !ts.Before(w.Start) && ts.Before(w.End)
}

// String renders the window as [start,end).
func (w Window) String() string {
	return fmt.Sprintf("[%s,%s)", w.Start.Format(time.RFC3339Nano), w.End.Format(time.RFC3339Nano))
}
