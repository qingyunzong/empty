package dataeng

import (
	"errors"
	"math/big"
	"sort"
)

// Exclusion selects which rows inside the key interval are removed from a
// window frame, matching the SQL frame-exclusion variants.
type Exclusion int

const (
	// ExcludeNone keeps every row whose key is inside the interval.
	ExcludeNone Exclusion = iota
	// ExcludeCurrentRow removes only the row for which the frame is computed.
	ExcludeCurrentRow
	// ExcludeGroup removes every row whose key equals the current row's key.
	ExcludeGroup
	// ExcludeTies removes every peer of the current row (same key) except the
	// current row itself.
	ExcludeTies
)

// Columns is the immutable columnar input of the window operator.
//
// All slices share one index space: row i has partition Partitions[i], sort
// key Keys[i], row ID RowIDs[i] and value Values[i]. A nil Values element is a
// SQL NULL. Rows must be sorted by (partition, key, row ID); row IDs must be
// unique across the whole relation.
type Columns[P comparable] struct {
	Partitions []P
	Keys       []int64
	RowIDs     []int64
	Values     []*int64
}

// Result is the window output for one row. Sum is nil when the effective
// frame contains no non-NULL value (the empty and all-NULL frames both yield
// a NULL sum); NonNullCount is the number of non-NULL values in the frame.
type Result struct {
	RowID        int64
	Sum          *big.Int
	NonNullCount int64
}

const (
	minInt64 int64 = -1 << 63
	maxInt64 int64 = 1<<63 - 1
)

// WindowSums evaluates, for every input row, the exact sum and the non-NULL
// count over the closed key interval [key-A, key+B] within the row's
// partition.
//
// A and B are non-negative offsets measured in mathematical integers; if an
// endpoint leaves the int64 range it saturates to the int64 boundary rather
// than wrapping. Exclusion further removes rows from the interval according
// to the SQL frame-exclusion semantics. The returned slice has one entry per
// input row, in input order.
func WindowSums[P comparable](in Columns[P], a, b uint64, exclusion Exclusion) ([]Result, error) {
	if err := validate(in, exclusion); err != nil {
		return nil, err
	}

	n := len(in.Keys)
	results := make([]Result, n)
	if n == 0 {
		return results, nil
	}

	// prefixSum[i] is the exact sum of the first i rows; prefixCount[i] is the
	// number of non-NULL values among the first i rows.
	prefixSum := make([]*big.Int, n+1)
	prefixCount := make([]int64, n+1)
	prefixSum[0] = new(big.Int)
	for i, v := range in.Values {
		prefixSum[i+1] = new(big.Int).Set(prefixSum[i])
		prefixCount[i+1] = prefixCount[i]
		if v != nil {
			prefixSum[i+1].Add(prefixSum[i+1], big.NewInt(*v))
			prefixCount[i+1]++
		}
	}

	for i := 0; i < n; {
		// Locate the contiguous range [partStart, partEnd) of this partition.
		partStart := i
		part := in.Partitions[i]
		for i < n && in.Partitions[i] == part {
			i++
		}
		partEnd := i

		for r := partStart; r < partEnd; r++ {
			lo := lowerBoundKey(in.Keys, partStart, partEnd, clampSub(in.Keys[r], a))
			hi := upperBoundKey(in.Keys, partStart, partEnd, clampAdd(in.Keys[r], b))

			groupLo := lowerBoundKey(in.Keys, partStart, partEnd, in.Keys[r])
			groupHi := upperBoundKey(in.Keys, partStart, partEnd, in.Keys[r])

			// The frame after exclusion is a union of at most three half-open
			// ranges; representing it explicitly keeps the middle-of-frame
			// exclusions (duplicate keys) correct.
			var kept [][2]int
			switch exclusion {
			case ExcludeCurrentRow:
				kept = appendKept(kept, lo, r)
				kept = appendKept(kept, r+1, hi)
			case ExcludeGroup:
				kept = appendKept(kept, lo, groupLo)
				kept = appendKept(kept, groupHi, hi)
			case ExcludeTies:
				kept = appendKept(kept, lo, groupLo)
				kept = appendKept(kept, r, r+1)
				kept = appendKept(kept, groupHi, hi)
			default:
				kept = appendKept(kept, lo, hi)
			}

			sum := new(big.Int)
			var cnt int64
			for _, rg := range kept {
				partSum, partCnt := rangeAggregate(prefixSum, prefixCount, rg[0], rg[1])
				sum.Add(sum, partSum)
				cnt += partCnt
			}
			results[r] = buildResult(in.RowIDs[r], sum, cnt)
		}
	}

	return results, nil
}

// validate enforces shape, ordering and uniqueness invariants of the input.
func validate[P comparable](in Columns[P], exclusion Exclusion) error {
	n := len(in.Keys)
	if len(in.Partitions) != n || len(in.RowIDs) != n || len(in.Values) != n {
		return errors.New("window input columns must have equal length")
	}
	if exclusion < ExcludeNone || exclusion > ExcludeTies {
		return errors.New("invalid frame exclusion")
	}
	if n == 0 {
		return nil
	}

	seenIDs := make(map[int64]struct{}, n)
	seenParts := make(map[P]struct{})
	var prev P
	for i, id := range in.RowIDs {
		if _, dup := seenIDs[id]; dup {
			return errors.New("row IDs must be unique")
		}
		seenIDs[id] = struct{}{}

		if i == 0 {
			seenParts[in.Partitions[0]] = struct{}{}
			prev = in.Partitions[0]
			continue
		}
		if in.Partitions[i] != prev {
			if _, earlier := seenParts[in.Partitions[i]]; earlier {
				return errors.New("input must be sorted by partition, key, row ID")
			}
			seenParts[in.Partitions[i]] = struct{}{}
			prev = in.Partitions[i]
			continue
		}
		if in.Keys[i-1] > in.Keys[i] ||
			(in.Keys[i-1] == in.Keys[i] && in.RowIDs[i-1] >= in.RowIDs[i]) {
			return errors.New("input must be sorted by partition, key, row ID")
		}
	}
	return nil
}

// clampSub returns key-off saturated into the int64 range.
func clampSub(key int64, off uint64) int64 {
	if off == 0 {
		return key
	}
	diff := new(big.Int).Sub(big.NewInt(key), new(big.Int).SetUint64(off))
	if diff.Cmp(big.NewInt(minInt64)) < 0 {
		return minInt64
	}
	return diff.Int64()
}

// clampAdd returns key+off saturated into the int64 range.
func clampAdd(key int64, off uint64) int64 {
	if off == 0 {
		return key
	}
	sum := new(big.Int).Add(big.NewInt(key), new(big.Int).SetUint64(off))
	if sum.Cmp(big.NewInt(maxInt64)) > 0 {
		return maxInt64
	}
	return sum.Int64()
}

// lowerBoundKey returns the first index in [start, end) whose key >= target.
func lowerBoundKey(keys []int64, start, end int, target int64) int {
	return start + sort.Search(end-start, func(i int) bool { return keys[start+i] >= target })
}

// upperBoundKey returns the first index in [start, end) whose key > target.
func upperBoundKey(keys []int64, start, end int, target int64) int {
	return start + sort.Search(end-start, func(i int) bool { return keys[start+i] > target })
}

// appendKept records [lo, hi) unless it is empty.
func appendKept(ranges [][2]int, lo, hi int) [][2]int {
	if lo < hi {
		return append(ranges, [2]int{lo, hi})
	}
	return ranges
}

// rangeAggregate reduces prefix aggregates over the half-open range [lo, hi).
func rangeAggregate(prefixSum []*big.Int, prefixCount []int64, lo, hi int) (*big.Int, int64) {
	return new(big.Int).Sub(prefixSum[hi], prefixSum[lo]), prefixCount[hi] - prefixCount[lo]
}

// buildResult maps an aggregate onto a Result, normalising an empty or
// all-NULL frame to a NULL sum.
func buildResult(rowID int64, sum *big.Int, nonNull int64) Result {
	if nonNull == 0 {
		return Result{RowID: rowID, Sum: nil, NonNullCount: 0}
	}
	return Result{RowID: rowID, Sum: sum, NonNullCount: nonNull}
}
