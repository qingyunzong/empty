// Package clocksim simulates uncertain node clocks. Each node observes
// "now" as an interval [Earliest, Latest] instead of a single instant.
// A committed write becomes visible to a read only when the read's
// earliest possible now is strictly later than the write's commit upper
// bound, so a read can never observe a write before it has definitely
// committed everywhere.
package clocksim

import "fmt"

// Interval is a node's uncertainty interval for the current time.
// Earliest is the smallest possible "now", Latest the largest.
type Interval struct {
	Earliest int64
	Latest   int64
}

// Valid reports whether Earliest <= Latest.
func (iv Interval) Valid() bool { return iv.Earliest <= iv.Latest }

// Contains reports whether t falls inside the interval (inclusive).
func (iv Interval) Contains(t int64) bool { return iv.Earliest <= t && t <= iv.Latest }

// Overlaps reports whether two intervals share at least one instant.
func (iv Interval) Overlaps(o Interval) bool {
	return iv.Earliest <= o.Latest && o.Earliest <= iv.Latest
}

// Shift returns the interval moved forward by d ticks.
func (iv Interval) Shift(d int64) Interval {
	return Interval{Earliest: iv.Earliest + d, Latest: iv.Latest + d}
}

func (iv Interval) String() string { return fmt.Sprintf("[%d,%d]", iv.Earliest, iv.Latest) }
