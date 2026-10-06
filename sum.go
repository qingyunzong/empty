// Package exactsum aggregates signed 64-bit values per group across many
// partitions. Accumulation is exact (arbitrary precision), so intermediate
// partial sums may exceed the int64 range freely; a group only fails when
// its final sum does not fit in int64. Errors are reported per group and
// never fail the whole result set.
package exactsum

import (
	"errors"
	"fmt"
	"math/big"
)

// ErrOverflow marks a group whose final sum lies outside the int64 range.
var ErrOverflow = errors.New("exactsum: final sum overflows int64")

// OverflowError describes a group whose exact final sum does not fit in
// an int64. The exact Sum is retained for inspection.
type OverflowError struct {
	Group string
	Sum   *big.Int
}

func (e *OverflowError) Error() string {
	return fmt.Sprintf("%v: group %q sum %s", ErrOverflow, e.Group, e.Sum)
}

func (e *OverflowError) Unwrap() error { return ErrOverflow }

// Result is the outcome for one group. Err is nil iff Sum is valid.
type Result struct {
	Sum int64
	Err error
}

// Aggregator accumulates per-group sums exactly. The zero value is ready
// to use. It is not safe for concurrent use.
type Aggregator struct {
	sums map[string]*big.Int
}

// New returns an empty Aggregator.
func New() *Aggregator {
	return &Aggregator{sums: make(map[string]*big.Int)}
}

// Add accumulates a single value into a group.
func (a *Aggregator) Add(group string, v int64) {
	a.lazyInit()
	acc, ok := a.sums[group]
	if !ok {
		acc = new(big.Int)
		a.sums[group] = acc
	}
	acc.Add(acc, big.NewInt(v))
}

// AddPartition accumulates one partition (batch) of values into a group.
// Partition boundaries and arrival order are irrelevant to the final sum.
func (a *Aggregator) AddPartition(group string, values ...int64) {
	if len(values) == 0 {
		return
	}
	a.lazyInit()
	acc, ok := a.sums[group]
	if !ok {
		acc = new(big.Int)
		a.sums[group] = acc
	}
	for _, v := range values {
		acc.Add(acc, big.NewInt(v))
	}
}

func (a *Aggregator) lazyInit() {
	if a.sums == nil {
		a.sums = make(map[string]*big.Int)
	}
}

// Result returns the outcome for a single group. A group with no values
// sums to zero.
func (a *Aggregator) Result(group string) Result {
	acc, ok := a.sums[group]
	if !ok {
		return Result{}
	}
	return finalize(group, acc)
}

// Results returns the outcome for every group seen so far. Groups whose
// final sum overflows int64 carry an *OverflowError (matching ErrOverflow);
// all other groups still report valid sums.
func (a *Aggregator) Results() map[string]Result {
	out := make(map[string]Result, len(a.sums))
	for group, acc := range a.sums {
		out[group] = finalize(group, acc)
	}
	return out
}

func finalize(group string, acc *big.Int) Result {
	if acc.IsInt64() {
		return Result{Sum: acc.Int64()}
	}
	return Result{Err: &OverflowError{Group: group, Sum: new(big.Int).Set(acc)}}
}
