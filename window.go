// Package telemetry provides a sliding-window, bucketed quantile estimator
// for integer samples. Quantile answers are bucket intervals guaranteed to
// cover the true rank; exact values are never fabricated.
package telemetry

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

// ErrConflictingValue is returned when an existing ID is re-added with a
// different value.
var ErrConflictingValue = errors.New("telemetry: duplicate ID with different value")

// Interval is a bucket interval (Lo, Hi]. An unset HasLo means -inf, an
// unset HasHi means +inf.
type Interval struct {
	Lo, Hi       int64
	HasLo, HasHi bool
}

// Contains reports whether v falls inside the interval.
func (iv Interval) Contains(v int64) bool {
	if iv.HasLo && v <= iv.Lo {
		return false
	}
	if iv.HasHi && v > iv.Hi {
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
	return fmt.Sprintf("(%s, %s]", lo, hi)
}

// Window is a sliding-window reservoir of integer samples classified into
// fixed buckets. Adds and retractions are O(log B) in the number of bucket
// boundaries; quantile queries are O(B).
type Window struct {
	bounds []int64 // strictly ascending bucket boundaries
	counts []int   // len(bounds)+1 bucket populations
	n      int     // live sample count
	cap    int     // max live samples; <=0 means unbounded
	live   map[string]int64
	queue  []string // FIFO of added IDs, lazily purged
	head   int
}

// NewWindow builds a Window with strictly ascending bucket boundaries.
// capacity <= 0 disables sliding (unbounded window).
func NewWindow(boundaries []int64, capacity int) (*Window, error) {
	for i := 1; i < len(boundaries); i++ {
		if boundaries[i] <= boundaries[i-1] {
			return nil, fmt.Errorf("telemetry: boundaries must be strictly ascending, got %v", boundaries)
		}
	}
	b := make([]int64, len(boundaries))
	copy(b, boundaries)
	return &Window{
		bounds: b,
		counts: make([]int, len(b)+1),
		cap:    capacity,
		live:   make(map[string]int64),
	}, nil
}

func (w *Window) bucketOf(v int64) int {
	return sort.Search(len(w.bounds), func(i int) bool { return v <= w.bounds[i] })
}

// Add inserts value under id. Re-adding the same id with the same value is a
// no-op; a conflicting value returns ErrConflictingValue. When the window is
// full, the oldest live sample is evicted first.
func (w *Window) Add(id string, value int64) error {
	if prev, ok := w.live[id]; ok {
		if prev != value {
			return fmt.Errorf("%w: id %q holds %d, got %d", ErrConflictingValue, id, prev, value)
		}
		return nil
	}
	if w.cap > 0 {
		for w.n >= w.cap {
			w.evictOldest()
		}
	}
	w.counts[w.bucketOf(value)]++
	w.live[id] = value
	w.queue = append(w.queue, id)
	w.n++
	return nil
}

func (w *Window) evictOldest() {
	for w.head < len(w.queue) {
		id := w.queue[w.head]
		w.head++
		if v, ok := w.live[id]; ok {
			delete(w.live, id)
			w.counts[w.bucketOf(v)]--
			w.n--
			return
		}
	}
	w.queue = w.queue[:0]
	w.head = 0
}

// Retract removes the sample stored under id, returning false if absent.
func (w *Window) Retract(id string) bool {
	v, ok := w.live[id]
	if !ok {
		return false
	}
	delete(w.live, id)
	w.counts[w.bucketOf(v)]--
	w.n--
	return true
}

// Len returns the number of live samples in the window.
func (w *Window) Len() int { return w.n }

// Quantile returns the narrowest bucket interval guaranteed to contain the
// value at rank ceil(q*n) of the live multiset, for 0 < q <= 1. The answer
// is always a whole bucket, never an interpolated point. ok is false when
// the window is empty or q is out of range.
func (w *Window) Quantile(q float64) (iv Interval, ok bool) {
	if w.n == 0 || q <= 0 || q > 1 || math.IsNaN(q) {
		return Interval{}, false
	}
	rank := int(math.Ceil(q * float64(w.n)))
	if rank < 1 {
		rank = 1
	}
	cum := 0
	for i, c := range w.counts {
		cum += c
		if cum >= rank {
			return w.interval(i), true
		}
	}
	return Interval{}, false
}

func (w *Window) interval(i int) Interval {
	var iv Interval
	if i > 0 {
		iv.Lo, iv.HasLo = w.bounds[i-1], true
	}
	if i < len(w.bounds) {
		iv.Hi, iv.HasHi = w.bounds[i], true
	}
	return iv
}
