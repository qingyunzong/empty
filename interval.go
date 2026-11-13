package dataeng

import (
	"bytes"
	"fmt"
)

// Key is a primary-key value. Keys are ordered lexicographically by their
// bytes.
type Key = []byte

// Interval is a closed primary-key interval. Both Start and End are included.
// An interval is valid exactly when Start <= End.
type Interval struct {
	Start Key
	End   Key
}

// Validate checks that the interval is a valid closed interval.
func (iv Interval) Validate() error {
	if bytes.Compare(iv.Start, iv.End) > 0 {
		return fmt.Errorf("%w: start=%q end=%q", ErrInvalidInterval, iv.Start, iv.End)
	}
	return nil
}

// Valid reports whether the interval is a valid closed interval.
func (iv Interval) Valid() bool {
	return bytes.Compare(iv.Start, iv.End) <= 0
}

// Contains reports whether key is in the inclusive interval. Invalid
// intervals contain no keys.
func (iv Interval) Contains(key Key) bool {
	return iv.Valid() &&
		bytes.Compare(key, iv.Start) >= 0 &&
		bytes.Compare(key, iv.End) <= 0
}

// Overlaps reports whether the two inclusive intervals share at least one
// key. Invalid intervals do not overlap anything.
func (iv Interval) Overlaps(other Interval) bool {
	return iv.Valid() && other.Valid() &&
		bytes.Compare(iv.Start, other.End) <= 0 &&
		bytes.Compare(other.Start, iv.End) <= 0
}

// CompareStart orders intervals by their start keys.
func (iv Interval) CompareStart(other Interval) int {
	return bytes.Compare(iv.Start, other.Start)
}

// String returns a readable representation of the interval.
func (iv Interval) String() string {
	return fmt.Sprintf("[%q, %q]", iv.Start, iv.End)
}

// ValidateInterval checks that interval is a valid closed interval.
func ValidateInterval(interval Interval) error {
	return interval.Validate()
}

// ValidateIntervals validates the interval assignment. Every interval must
// have Start <= End, and no two intervals may share a start. Intervals with
// different starts may overlap; ownership is resolved by the Validator.
func ValidateIntervals(intervals []Interval) error {
	starts := make(map[string]int, len(intervals))
	for i, interval := range intervals {
		if err := interval.Validate(); err != nil {
			return fmt.Errorf("interval %d: %w", i, err)
		}
		start := string(interval.Start)
		if previous, exists := starts[start]; exists {
			return fmt.Errorf("%w: intervals %d and %d start at %q",
				ErrDuplicateStart, previous, i, interval.Start)
		}
		starts[start] = i
	}
	return nil
}
