// Package partsum aggregates signed 64-bit values that arrive in multiple
// unordered partitions, grouped by key.
//
// Accumulation is exact (arbitrary precision): intermediate partial sums may
// freely exceed the int64 range, because later partitions can cancel them
// back in range. Only the final per-group sum is range-checked; if it does
// not fit in int64, that group alone carries an *OverflowError while every
// other group still reports its result.
package partsum

import (
	"fmt"
	"math/big"
)

// Partition is one unordered batch of values belonging to a single group.
// Partitions for the same group may arrive in any order and any number.
type Partition struct {
	Group  string
	Values []int64
}

// GroupResult is the aggregation outcome for one group. Err is nil unless
// this group's final sum overflows int64; other groups are unaffected.
type GroupResult struct {
	Group string
	Sum   int64
	Err   error
}

// OverflowError reports that a group's exact final sum does not fit in int64.
type OverflowError struct {
	Group string
	Sum   *big.Int // exact final sum, out of int64 range
}

func (e *OverflowError) Error() string {
	return fmt.Sprintf("partsum: group %q: final sum %s overflows int64", e.Group, e.Sum)
}

// Sum aggregates partitions per group and returns one GroupResult per group,
// in first-seen group order. It never fails as a whole: a group whose final
// sum is out of int64 range gets an *OverflowError in its own GroupResult.
func Sum(partitions []Partition) []GroupResult {
	acc := make(map[string]*big.Int)
	var order []string
	for _, p := range partitions {
		total, ok := acc[p.Group]
		if !ok {
			total = new(big.Int)
			acc[p.Group] = total
			order = append(order, p.Group)
		}
		for _, v := range p.Values {
			total.Add(total, big.NewInt(v))
		}
	}

	results := make([]GroupResult, 0, len(order))
	for _, group := range order {
		total := acc[group]
		if total.IsInt64() {
			results = append(results, GroupResult{Group: group, Sum: total.Int64()})
		} else {
			results = append(results, GroupResult{
				Group: group,
				Err:   &OverflowError{Group: group, Sum: new(big.Int).Set(total)},
			})
		}
	}
	return results
}
