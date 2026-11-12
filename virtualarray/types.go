// Package virtualarray reads rectangular regions of a virtual array that is
// assembled from point-wise mappings into one or more source arrays.
//
// The package never parses HDF5 (or any other on-disk format): mapping
// metadata is supplied directly as Go values. Every shape length, selection
// parameter, coordinate and linear index is an arbitrary-precision
// [math/big.Int], so metadata beyond 2^53 or even 2^64 stays exact.
//
// A read never enumerates a whole selection or allocates an index slice
// sized by the total selection point count. Requested points are located
// with pure membership/rank/unrank arithmetic, source positions are
// deduplicated, adjacent positions are merged into batched half-open
// intervals and every distinct source position is read at most once.
package virtualarray

import (
	"context"
	"math/big"
)

// Order is the storage order used to flatten a source array into its raw
// int64 element sequence.
type Order int

const (
	// COrder stores the last dimension fastest (C / row-major order).
	COrder Order = iota + 1
	// FOrder stores the first dimension fastest (Fortran / column-major).
	FOrder
)

// String returns "C" or "F".
func (o Order) String() string {
	switch o {
	case COrder:
		return "C"
	case FOrder:
		return "F"
	default:
		return "unknown"
	}
}

// valid reports whether o is one of the defined storage orders.
func (o Order) valid() bool {
	return o == COrder || o == FOrder
}

const (
	// minRank and maxRank bound the supported number of dimensions.
	minRank = 1
	maxRank = 8
)

// AxisSel is a hyperslab along one axis: the selected coordinates are
//
//	start + i*stride + j,  0 <= i < count, 0 <= j < block
//
// stride and block must be positive with stride >= block; count may be zero.
// A zero-count axis makes the whole selection empty.
type AxisSel struct {
	Start  *big.Int
	Stride *big.Int
	Count  *big.Int
	Block  *big.Int
}

// Selection is an ordered, rank-matched collection of per-axis hyperslabs.
// Its points are ordered lexicographically by coordinate, with the last
// axis varying fastest.
type Selection struct {
	Axes []AxisSel
}

// Mapping maps every point of VirtualSel, in point order, onto the point of
// SourceSel with the same ordinal. The source and virtual arrays may have
// different rank and shape; only the selected point counts have to match.
type Mapping struct {
	SourceName  string
	SourceShape []*big.Int
	VirtualSel  Selection
	SourceSel   Selection
	// Order optionally declares this mapping's expected source storage
	// order. The zero value means the order comes from the New sourceOrder
	// table. When set it must agree with every declaration for the source.
	Order Order
}

// Snapshot is the host's immutable per-read view of which sources are
// available. A source name absent from the map is treated as unavailable,
// which is a valid fill condition rather than a read failure.
type Snapshot map[string]bool

// Span is a half-open interval of flattened source element indices:
// [Lo, Hi). ReadFunc must return the raw int64 values for every index in
// the interval, in increasing index order.
type Span struct {
	Lo *big.Int
	Hi *big.Int
}

// ReadFunc reads a batch of contiguous spans from one source. The spans are
// sorted, disjoint and non-adjacent (adjacent indices are already merged),
// and the returned slice must contain the values of every requested span
// laid out in span then index order; its length must equal the sum of the
// span lengths. A non-nil error fails the whole read and no partial batch is
// delivered. The fill value is never interpreted as a missing marker, so a
// ReadFunc that returns fill values is still a successful read.
type ReadFunc func(ctx context.Context, source string, spans []Span) ([]int64, error)

// Rect is a half-open virtual request box: axis d covers [Lo[d], Hi[d]).
// Lo and Hi must have the virtual array's rank and satisfy
// 0 <= Lo[d] <= Hi[d] <= shape[d]. An empty rectangle yields zero points
// and never triggers a source callback.
type Rect struct {
	Lo []*big.Int
	Hi []*big.Int
}

// FillReason explains why a point was returned as the fill value.
type FillReason int

const (
	// NotFilled means the point was read from a source and is not fill.
	NotFilled FillReason = iota
	// NoMapping means no mapping selected the point.
	NoMapping
	// SourceUnavailable means the winning mapping's source was absent from
	// the availability snapshot. Earlier mappings must not be retried.
	SourceUnavailable
)

// String returns a short human-readable reason.
func (r FillReason) String() string {
	switch r {
	case NotFilled:
		return "not-filled"
	case NoMapping:
		return "no-mapping"
	case SourceUnavailable:
		return "source-unavailable"
	default:
		return "unknown"
	}
}

// Point describes the provenance of one result element.
type Point struct {
	// MappingIndex is the winning mapping's index in the mapping list, or -1
	// when no mapping covers the point.
	MappingIndex int
	// SourceName is the winning mapping's source, or "" when no mapping
	// covers the point.
	SourceName string
	// VirtualCoord is the point's coordinate in the virtual array.
	VirtualCoord []*big.Int
	// SourceCoord is the corresponding source coordinate, or nil when the
	// point was filled (no mapping or unavailable source).
	SourceCoord []*big.Int
	// Filled reports whether the value is the fill value.
	Filled bool
	// FillReason is meaningful only when Filled is true.
	FillReason FillReason
}

// ReadResult is the C-ordered output of a rectangular read.
type ReadResult struct {
	// Values holds the int64 values in C order (last axis fastest), one per
	// requested point. Fill points contain the configured fill value.
	Values []int64
	// Points holds provenance for the same points and indices as Values.
	Points []Point
}
