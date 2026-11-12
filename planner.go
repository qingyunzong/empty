// Package dataeng provides a read-request planner for remote columnar
// storage that is billed per range request.
//
// Cost model: each request costs a non-negative rational fixed overhead
// plus a non-negative rational per-byte price multiplied by the request
// span. A request span must not exceed a positive integer limit M.
//
// Canonical form (why partitions are enough):
//
// Let the merged (disjoint, sorted) required intervals be I_1..I_n.
// Take any feasible set of requests. Assign every merged interval to
// exactly one request that covers it, and shrink each request to
// [min start, max end) of the intervals assigned to it. Because the
// per-byte price is non-negative, shrinking never increases cost; the
// shrunken span still fits within M because it is contained in the
// original request. If a request ends up with no assigned interval it
// can be dropped, which never increases cost because the fixed overhead
// is non-negative. If one request's intervals interleave with another's
// (request A owns I_i and I_k while request B owns I_j with i<j<k),
// reassign I_j to A: A already spans it, so cost does not increase and
// the request count can only drop once B empties. Repeating yields a
// solution in which requests are disjoint, ordered, and each request is
// exactly [start of first interval, end of last interval) of a
// contiguous group of merged intervals — i.e. a partition of I_1..I_n
// into contiguous groups. Overlapping requests are therefore never
// beneficial, and restricting request boundaries to merged-interval
// boundaries (which also keeps requests inside the file) loses nothing.
//
// The planner below is an O(n^2) dynamic program over exactly those
// partitions, so its output is optimal by construction.
package dataeng

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
)

// Interval is a half-open byte range [Start, End).
type Interval struct {
	Start int64
	End   int64
}

// Len returns the length of the interval in bytes.
func (iv Interval) Len() int64 { return iv.End - iv.Start }

// Params configures the planner.
type Params struct {
	// FileLen is the total file length in bytes. Requests may not cross
	// [0, FileLen).
	FileLen int64
	// MaxSpan is the maximum allowed request span M (> 0).
	MaxSpan int64
	// Fixed is the non-negative rational fixed overhead per request.
	Fixed *big.Rat
	// PerByte is the non-negative rational price per byte read.
	PerByte *big.Rat
}

// Result is the outcome of Plan.
type Result struct {
	// Feasible reports whether every requirement can be covered.
	Feasible bool
	// Merged holds the required intervals after sorting and merging
	// overlaps (and adjacencies).
	Merged []Interval
	// TooLong lists the merged intervals whose length exceeds MaxSpan.
	// It is non-empty exactly when Feasible is false.
	TooLong []Interval
	// Requests is the optimal request list, sorted and non-overlapping.
	// Nil when infeasible.
	Requests []Interval
	// Covers maps each request to the sorted indices of the original
	// (pre-merge) required intervals it covers. Covers[k] corresponds
	// to Requests[k].
	Covers [][]int
	// Cost is the total cost of Requests. Nil when infeasible.
	Cost *big.Rat
}

// Plan computes a minimum-cost set of read requests covering all
// required intervals of a file of p.FileLen bytes.
//
// reqs must be non-empty intervals inside [0, p.FileLen). Among all
// minimum-cost solutions, Plan prefers fewer requests, then the
// lexicographically smallest request list (intervals compare by Start,
// then End).
func Plan(reqs []Interval, p Params) (Result, error) {
	if err := validate(reqs, p); err != nil {
		return Result{}, err
	}
	merged, owners := merge(reqs)

	res := Result{Merged: merged}
	for _, iv := range merged {
		if iv.Len() > p.MaxSpan {
			res.TooLong = append(res.TooLong, iv)
		}
	}
	if len(res.TooLong) > 0 {
		return res, nil
	}
	res.Feasible = true
	if len(merged) == 0 {
		res.Cost = new(big.Rat)
		return res, nil
	}

	n := len(merged)
	groupCost := func(i, j int) *big.Rat { // cost of one request covering merged[i..j]
		span := new(big.Rat).SetInt64(merged[j].End - merged[i].Start)
		return new(big.Rat).Add(new(big.Rat).Mul(p.PerByte, span), p.Fixed)
	}

	// dp[j] is the best solution covering merged[:j].
	type state struct {
		cost  *big.Rat
		reqs  []Interval
		owner [][]int // merged-interval indices per request
	}
	better := func(a, b *state) bool { // is a strictly better than b?
		if b == nil {
			return true
		}
		if c := a.cost.Cmp(b.cost); c != 0 {
			return c < 0
		}
		if len(a.reqs) != len(b.reqs) {
			return len(a.reqs) < len(b.reqs)
		}
		return lessIntervals(a.reqs, b.reqs)
	}

	dp := make([]*state, n+1)
	dp[0] = &state{cost: new(big.Rat)}
	for j := 1; j <= n; j++ {
		for i := 0; i < j; i++ {
			if merged[j-1].End-merged[i].Start > p.MaxSpan {
				continue
			}
			prev := dp[i]
			if prev == nil {
				continue
			}
			cand := &state{
				cost:  new(big.Rat).Add(prev.cost, groupCost(i, j-1)),
				reqs:  append(append([]Interval{}, prev.reqs...), Interval{merged[i].Start, merged[j-1].End}),
				owner: append(append([][]int{}, prev.owner...), rangeInts(i, j-1)),
			}
			if better(cand, dp[j]) {
				dp[j] = cand
			}
		}
	}

	best := dp[n]
	res.Requests = best.reqs
	res.Cost = best.cost
	res.Covers = make([][]int, len(best.owner))
	for k, group := range best.owner {
		var idx []int
		for _, m := range group {
			idx = append(idx, owners[m]...)
		}
		sort.Ints(idx)
		res.Covers[k] = idx
	}
	return res, nil
}

func validate(reqs []Interval, p Params) error {
	if p.FileLen < 0 {
		return fmt.Errorf("dataeng: FileLen must be non-negative, got %d", p.FileLen)
	}
	if p.MaxSpan <= 0 {
		return fmt.Errorf("dataeng: MaxSpan must be positive, got %d", p.MaxSpan)
	}
	if p.Fixed == nil || p.Fixed.Sign() < 0 {
		return errors.New("dataeng: Fixed must be a non-negative rational")
	}
	if p.PerByte == nil || p.PerByte.Sign() < 0 {
		return errors.New("dataeng: PerByte must be a non-negative rational")
	}
	for i, iv := range reqs {
		if iv.Start < 0 || iv.End > p.FileLen || iv.Start >= iv.End {
			return fmt.Errorf("dataeng: requirement %d %v is empty or outside [0, %d)", i, iv, p.FileLen)
		}
	}
	return nil
}

// merge sorts reqs and merges overlapping or touching intervals,
// returning the merged intervals and, for each, the sorted indices of
// the original requirements it absorbs.
func merge(reqs []Interval) ([]Interval, [][]int) {
	type item struct {
		iv  Interval
		idx int
	}
	items := make([]item, len(reqs))
	for i, iv := range reqs {
		items[i] = item{iv, i}
	}
	sort.Slice(items, func(a, b int) bool {
		if items[a].iv.Start != items[b].iv.Start {
			return items[a].iv.Start < items[b].iv.Start
		}
		return items[a].iv.End < items[b].iv.End
	})
	var merged []Interval
	var owners [][]int
	for _, it := range items {
		if n := len(merged); n > 0 && it.iv.Start <= merged[n-1].End {
			if it.iv.End > merged[n-1].End {
				merged[n-1].End = it.iv.End
			}
			owners[n-1] = append(owners[n-1], it.idx)
			continue
		}
		merged = append(merged, it.iv)
		owners = append(owners, []int{it.idx})
	}
	return merged, owners
}

// lessIntervals reports whether a is lexicographically smaller than b,
// comparing intervals by Start then End; a proper prefix is smaller.
func lessIntervals(a, b []Interval) bool {
	for k := 0; k < len(a) && k < len(b); k++ {
		if a[k].Start != b[k].Start {
			return a[k].Start < b[k].Start
		}
		if a[k].End != b[k].End {
			return a[k].End < b[k].End
		}
	}
	return len(a) < len(b)
}

func rangeInts(lo, hi int) []int {
	out := make([]int, hi-lo+1)
	for k := range out {
		out[k] = lo + k
	}
	return out
}
