// Package telemetry implements a sliding-window sample store that classifies
// integer values into configured buckets and reports quantiles as the
// narrowest bucket interval guaranteed to cover the true rank, never
// fabricating an exact value.
package telemetry

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

// ErrDuplicateID is returned when an ID is re-added with a different value.
var ErrDuplicateID = errors.New("telemetry: duplicate id with different value")

// Interval is a bucket range [Lo, Hi). An unset HasLo/HasHi means the
// corresponding side is open (extends to -inf / +inf).
type Interval struct {
	Lo    int
	Hi    int
	HasLo bool
	HasHi bool
}

// Contains reports whether v falls inside the interval.
func (iv Interval) Contains(v int) bool {
	if iv.HasLo && v < iv.Lo {
		return false
	}
	if iv.HasHi && v >= iv.Hi {
		return false
	}
	return true
}

func (iv Interval) String() string {
	lo, hi := "-inf", "+inf"
	if iv.HasLo {
		lo = fmt.Sprintf("%d", iv.Lo)
	}
	if iv.HasHi {
		hi = fmt.Sprintf("%d", iv.Hi)
	}
	return "[" + lo + ", " + hi + ")"
}

// Window is a sliding-window sample store. It keeps at most size samples;
// when full, the oldest sample is evicted as a new one arrives.
type Window struct {
	bounds []int // strictly ascending bucket boundaries
	size   int
	order  []string // live IDs in insertion order
	values map[string]int
}

// New creates a Window with the given bucket boundaries and capacity.
// Boundaries must be strictly ascending; size must be positive.
func New(boundaries []int, size int) (*Window, error) {
	if size <= 0 {
		return nil, fmt.Errorf("telemetry: window size must be positive, got %d", size)
	}
	bounds := make([]int, len(boundaries))
	copy(bounds, boundaries)
	for i := 1; i < len(bounds); i++ {
		if bounds[i] <= bounds[i-1] {
			return nil, fmt.Errorf("telemetry: boundaries must be strictly ascending (index %d)", i)
		}
	}
	return &Window{
		bounds: bounds,
		size:   size,
		values: make(map[string]int),
	}, nil
}

// Add inserts a sample. Re-adding an existing ID with the same value is a
// no-op; re-adding it with a different value returns ErrDuplicateID and
// leaves the store unchanged. When the window is full the oldest sample is
// evicted first.
func (w *Window) Add(id string, value int) error {
	if v, ok := w.values[id]; ok {
		if v != value {
			return fmt.Errorf("%w: id %q holds %d, got %d", ErrDuplicateID, id, v, value)
		}
		return nil
	}
	if len(w.order) == w.size {
		oldest := w.order[0]
		w.order = w.order[1:]
		delete(w.values, oldest)
	}
	w.order = append(w.order, id)
	w.values[id] = value
	return nil
}

// Retract removes the sample with the given ID, reporting whether it existed.
func (w *Window) Retract(id string) bool {
	if _, ok := w.values[id]; !ok {
		return false
	}
	delete(w.values, id)
	for i, cur := range w.order {
		if cur == id {
			w.order = append(w.order[:i], w.order[i+1:]...)
			break
		}
	}
	return true
}

// Len reports the number of live samples in the window.
func (w *Window) Len() int { return len(w.values) }

// Locate returns the bucket interval containing value: the narrowest
// interval bounded by adjacent configured boundaries that covers it.
func (w *Window) Locate(value int) Interval {
	i := sort.SearchInts(w.bounds, value) // first index with bounds[i] >= value
	var iv Interval
	if i < len(w.bounds) && w.bounds[i] == value {
		iv.Lo, iv.HasLo = value, true
		if i+1 < len(w.bounds) {
			iv.Hi, iv.HasHi = w.bounds[i+1], true
		}
		return iv
	}
	if i > 0 {
		iv.Lo, iv.HasLo = w.bounds[i-1], true
	}
	if i < len(w.bounds) {
		iv.Hi, iv.HasHi = w.bounds[i], true
	}
	return iv
}

// Quantile returns the narrowest bucket interval guaranteed to contain the
// value at rank ceil(q*n) (1-based) of the sorted live samples, for
// 0 < q <= 1. It reports ok=false when the window is empty or q is out of
// range. Only bucket bounds are returned; no exact value is fabricated.
func (w *Window) Quantile(q float64) (iv Interval, ok bool) {
	n := len(w.values)
	if n == 0 || q <= 0 || q > 1 {
		return Interval{}, false
	}
	vals := make([]int, 0, n)
	for _, v := range w.values {
		vals = append(vals, v)
	}
	sort.Ints(vals)
	rank := int(math.Ceil(q * float64(n)))
	if rank < 1 {
		rank = 1
	}
	return w.Locate(vals[rank-1]), true
}
