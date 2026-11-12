package dataeng

import (
	"fmt"
	"sort"
)

// Time is a logical time in the product order. X represents the outer batch
// and Y represents the inner iteration. The order is componentwise: t <= u iff
// t.X <= u.X and t.Y <= u.Y.
type Time struct {
	X uint64 `json:"x"`
	Y uint64 `json:"y"`
}

// LessOrEqual reports whether t <= u in the product order.
func (t Time) LessOrEqual(u Time) bool {
	return t.X <= u.X && t.Y <= u.Y
}

// LessThan reports whether t <= u and t != u.
func (t Time) LessThan(u Time) bool {
	return t.LessOrEqual(u) && t != u
}

// Le is shorthand for LessOrEqual.
func (t Time) Le(u Time) bool {
	return t.LessOrEqual(u)
}

// Lt is shorthand for LessThan.
func (t Time) Lt(u Time) bool {
	return t.LessThan(u)
}

// Join returns the componentwise maximum of t and u.
func Join(t, u Time) Time {
	return Time{X: max(t.X, u.X), Y: max(t.Y, u.Y)}
}

// Meet returns the componentwise minimum of t and u.
func Meet(t, u Time) Time {
	return Time{X: min(t.X, u.X), Y: min(t.Y, u.Y)}
}

func (t Time) String() string {
	return fmt.Sprintf("(%d,%d)", t.X, t.Y)
}

// Antichain is a normalized finite set of incomparable times. The zero value
// is the empty antichain.
type Antichain struct {
	points []Time
}

// NewAntichain builds a normalized antichain. Equal points are deduplicated,
// and any point that is greater than or equal to another point is removed.
func NewAntichain(points ...Time) Antichain {
	return Antichain{points: normalizePoints(points)}
}

// Points returns a copy of the normalized points, sorted by (x,y). Sorting is
// only a presentation concern; no algorithm in this package relies on lexical
// ordering.
func (a Antichain) Points() []Time {
	if len(a.points) == 0 {
		return nil
	}
	out := make([]Time, len(a.points))
	copy(out, a.points)
	return out
}

// Len returns the number of points in the antichain.
func (a Antichain) Len() int {
	return len(a.points)
}

// IsEmpty reports whether the antichain has no points.
func (a Antichain) IsEmpty() bool {
	return len(a.points) == 0
}

// Dominates reports whether some point p in a satisfies p <= t. This is the
// condition used by both input frontiers (an update may be at t when the
// frontier dominates t) and by since (a query q is allowed when since
// dominates q).
func (a Antichain) Dominates(t Time) bool {
	for _, p := range a.points {
		if p.LessOrEqual(t) {
			return true
		}
	}
	return false
}

// Equal reports whether two antichains contain the same normalized points.
func (a Antichain) Equal(b Antichain) bool {
	if len(a.points) != len(b.points) {
		return false
	}
	for i := range a.points {
		if a.points[i] != b.points[i] {
			return false
		}
	}
	return true
}

// Compact applies the since compaction formula to t:
//
//	meet{join(t, f) : f in since}
//
// For two dimensions this is equal to componentwise
//
//	(max(t.X, minSinceX), max(t.Y, minSinceY)).
//
// An empty since leaves t unchanged; the host never compacts records against
// an empty since because that state clears history.
func (a Antichain) Compact(t Time) Time {
	if len(a.points) == 0 {
		return t
	}
	minX, minY := a.points[0].X, a.points[0].Y
	for _, p := range a.points[1:] {
		minX = min(minX, p.X)
		minY = min(minY, p.Y)
	}
	return Time{X: max(t.X, minX), Y: max(t.Y, minY)}
}

func normalizePoints(points []Time) []Time {
	if len(points) == 0 {
		return nil
	}

	sorted := make([]Time, len(points))
	copy(sorted, points)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].X != sorted[j].X {
			return sorted[i].X < sorted[j].X
		}
		return sorted[i].Y < sorted[j].Y
	})

	unique := sorted[:0]
	for _, p := range sorted {
		if len(unique) == 0 || unique[len(unique)-1] != p {
			unique = append(unique, p)
		}
	}

	out := make([]Time, 0, len(unique))
	for i, p := range unique {
		dominated := false
		for j, q := range unique {
			if i != j && q.LessOrEqual(p) {
				dominated = true
				break
			}
		}
		if !dominated {
			out = append(out, p)
		}
	}
	return out
}
