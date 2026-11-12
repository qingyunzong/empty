package dataeng

import (
	"errors"
	"fmt"
	"math"
)

// MaxDepth is the maximum supported list-view nesting depth. A view whose
// child is a scalar array has depth 1.
const MaxDepth = 32

// ErrMaxDepth is returned when a list view is nested deeper than MaxDepth.
var ErrMaxDepth = errors.New("list view nesting exceeds MaxDepth")

// Int64Array is a shared, nullable int64 child array.
type Int64Array struct {
	Values []int64
	Valid  []bool
}

// ListView describes a list column whose rows are (possibly overlapping or
// out-of-order) ranges into a shared child. Child is *Int64Array or *ListView.
// Starts and Lengths of null rows are never read.
type ListView struct {
	Starts  []int64
	Lengths []int64
	Valid   []bool
	Child   any
}

// ListColumn is a compacted list column with standard contiguous offsets.
// Positions records, for every output child slot, the original index in the
// input shared child at this level. Child is *Int64Array or *ListColumn.
type ListColumn struct {
	Offsets   []int64
	Valid     []bool
	Positions []int64
	Child     any
}

// Compact rebuilds a list view as a standard contiguous-offset list column.
// Only child values of valid rows are copied, in row order; null rows get
// zero length and empty lists stay non-null.
func Compact(v *ListView) (*ListColumn, error) {
	return compactView(v, 1)
}

func compactView(v *ListView, depth int) (*ListColumn, error) {
	if v == nil {
		return nil, errors.New("dataeng: nil list view")
	}
	if depth > MaxDepth {
		return nil, fmt.Errorf("dataeng: nesting depth %d: %w", depth, ErrMaxDepth)
	}
	rows := len(v.Valid)
	if len(v.Starts) != rows || len(v.Lengths) != rows {
		return nil, fmt.Errorf("dataeng: row count mismatch: %d starts, %d lengths, %d valid bits",
			len(v.Starts), len(v.Lengths), rows)
	}
	var childLen int64
	switch c := v.Child.(type) {
	case *Int64Array:
		if c == nil {
			return nil, errors.New("dataeng: nil *Int64Array child")
		}
		if len(c.Valid) != len(c.Values) {
			return nil, fmt.Errorf("dataeng: child has %d values but %d valid bits",
				len(c.Values), len(c.Valid))
		}
		childLen = int64(len(c.Values))
	case *ListView:
		if c == nil {
			return nil, errors.New("dataeng: nil *ListView child")
		}
		if len(c.Starts) != len(c.Valid) || len(c.Lengths) != len(c.Valid) {
			return nil, fmt.Errorf("dataeng: child view row count mismatch: %d starts, %d lengths, %d valid bits",
				len(c.Starts), len(c.Lengths), len(c.Valid))
		}
		childLen = int64(len(c.Valid))
	default:
		return nil, fmt.Errorf("dataeng: unsupported child type %T", v.Child)
	}

	offsets, total, err := validateRanges(v.Starts, v.Lengths, v.Valid, childLen)
	if err != nil {
		return nil, err
	}
	if total > int64(math.MaxInt) {
		return nil, fmt.Errorf("dataeng: total child length %d exceeds platform int", total)
	}
	n := int(total)

	out := &ListColumn{
		Offsets: offsets,
		Valid:   append([]bool(nil), v.Valid...),
	}
	positions := make([]int64, 0, n)
	switch c := v.Child.(type) {
	case *Int64Array:
		values := make([]int64, 0, n)
		validBits := make([]bool, 0, n)
		for i := 0; i < rows; i++ {
			if !v.Valid[i] {
				continue
			}
			for j := v.Starts[i]; j < v.Starts[i]+v.Lengths[i]; j++ {
				values = append(values, c.Values[j])
				validBits = append(validBits, c.Valid[j])
				positions = append(positions, j)
			}
		}
		out.Child = &Int64Array{Values: values, Valid: validBits}
	case *ListView:
		sub := &ListView{
			Starts:  make([]int64, 0, n),
			Lengths: make([]int64, 0, n),
			Valid:   make([]bool, 0, n),
			Child:   c.Child,
		}
		for i := 0; i < rows; i++ {
			if !v.Valid[i] {
				continue
			}
			for j := v.Starts[i]; j < v.Starts[i]+v.Lengths[i]; j++ {
				sub.Starts = append(sub.Starts, c.Starts[j])
				sub.Lengths = append(sub.Lengths, c.Lengths[j])
				sub.Valid = append(sub.Valid, c.Valid[j])
				positions = append(positions, j)
			}
		}
		inner, err := compactView(sub, depth+1)
		if err != nil {
			return nil, err
		}
		out.Child = inner
	}
	out.Positions = positions
	return out, nil
}

// validateRanges checks the ranges of valid rows against childLen and
// returns contiguous offsets plus the total copied length. Starts and
// lengths of null rows are never read.
func validateRanges(starts, lengths []int64, valid []bool, childLen int64) ([]int64, int64, error) {
	offsets := make([]int64, len(valid)+1)
	var total int64
	for i := 0; i < len(valid); i++ {
		if valid[i] {
			start, length := starts[i], lengths[i]
			if start < 0 || start > childLen {
				return nil, 0, fmt.Errorf("dataeng: row %d: start %d out of bounds [0, %d]", i, start, childLen)
			}
			if length < 0 || length > childLen-start {
				return nil, 0, fmt.Errorf("dataeng: row %d: length %d out of bounds [0, %d]", i, length, childLen-start)
			}
			if length > math.MaxInt64-total {
				return nil, 0, fmt.Errorf("dataeng: row %d: total child length overflows int64", i)
			}
			total += length
		}
		offsets[i+1] = total
	}
	return offsets, total, nil
}
