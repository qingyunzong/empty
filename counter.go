// Package counter reconstructs monotonic event totals from cumulative
// counter readings that carry a bit width and an explicit reset flag.
//
// Semantics:
//   - Readings are cumulative values of a counter with a fixed bit width.
//   - A reading with Reset set marks an explicit reset: the interval that
//     ends at it is unknown, and the reading itself becomes the new baseline.
//   - A decrease between consecutive readings is treated as a single
//     wrap-around (modulo compensation) only when the counter was created
//     with wrap allowed; otherwise the interval is unknown.
//   - Multiple wraps between two readings are never inferred: at most one
//     wrap is compensated per interval.
//   - Duplicate timestamps are resolved by keeping the reading with the
//     highest version; ties keep the later reading in input order.
package counter

import (
	"errors"
	"fmt"
	"sort"
)

// Reading is a single cumulative counter sample.
type Reading struct {
	Time    int64  // sample timestamp (any monotonic time unit)
	Value   uint64 // cumulative counter value, must fit Width bits
	Reset   bool   // explicit reset marker: counter was reset before this sample
	Version int    // conflict resolution key for duplicate timestamps
}

// Interval describes a time range whose delta could not be computed.
type Interval struct {
	Start  int64
	End    int64
	Reason string
}

// Result is the outcome of processing a reading stream.
type Result struct {
	Total   uint64     // sum of deltas over all computable intervals
	Known   int        // number of computable intervals
	Unknown []Interval // intervals whose delta is not computable
}

// Counter processes readings of a fixed-width cumulative counter.
type Counter struct {
	width     uint
	mask      uint64 // (1<<width)-1; all ones for width == 64
	modulus   uint64 // 1<<width; 0 for width == 64 (unused then)
	allowWrap bool
}

// New returns a Counter for readings of the given bit width (1..64).
// allowWrap permits compensating a single wrap-around on value decrease.
func New(width uint, allowWrap bool) (*Counter, error) {
	if width < 1 || width > 64 {
		return nil, fmt.Errorf("counter: width %d out of range [1,64]", width)
	}
	c := &Counter{width: width, mask: ^uint64(0), allowWrap: allowWrap}
	if width < 64 {
		c.modulus = uint64(1) << width
		c.mask = c.modulus - 1
	}
	return c, nil
}

// ErrValueOverflow reports a reading that does not fit the counter width.
var ErrValueOverflow = errors.New("counter: reading value exceeds bit width")

// Process folds a stream of readings into a Result. The input is not
// modified. Readings may arrive in any order and with duplicate timestamps.
func (c *Counter) Process(readings []Reading) (Result, error) {
	rs, err := c.normalize(readings)
	if err != nil {
		return Result{}, err
	}
	var res Result
	for i := 1; i < len(rs); i++ {
		prev, cur := rs[i-1], rs[i]
		switch {
		case cur.Reset:
			res.Unknown = append(res.Unknown, Interval{prev.Time, cur.Time, "explicit reset"})
		case cur.Value >= prev.Value:
			res.Total += cur.Value - prev.Value
			res.Known++
		case c.allowWrap:
			// Exactly one wrap: delta = (cur - prev) mod 2^width.
			res.Total += (cur.Value - prev.Value) & c.mask
			res.Known++
		default:
			res.Unknown = append(res.Unknown, Interval{prev.Time, cur.Time, "decrease without wrap"})
		}
	}
	return res, nil
}

// normalize validates values, sorts by time, and collapses duplicate
// timestamps to the highest-version reading.
func (c *Counter) normalize(readings []Reading) ([]Reading, error) {
	rs := make([]Reading, len(readings))
	for i, r := range readings {
		if c.modulus != 0 && r.Value >= c.modulus {
			return nil, fmt.Errorf("%w: value %d at time %d (width %d)", ErrValueOverflow, r.Value, r.Time, c.width)
		}
		rs[i] = r
	}
	// Stable sort keeps input order among equal (Time, Version) pairs, so
	// the last element of a duplicate-time group is the highest version,
	// breaking version ties toward the later input.
	sort.SliceStable(rs, func(i, j int) bool {
		if rs[i].Time != rs[j].Time {
			return rs[i].Time < rs[j].Time
		}
		return rs[i].Version < rs[j].Version
	})
	out := rs[:0]
	for _, r := range rs {
		if n := len(out); n > 0 && out[n-1].Time == r.Time {
			out[n-1] = r
			continue
		}
		out = append(out, r)
	}
	return out, nil
}
