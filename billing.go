// Package billing computes exact fractional charges from piecewise-constant
// rational price segments and an integer usage curve, both defined over
// half-open intervals [Start, End) of integer ticks.
//
// Prices and usages are rates per tick: a line item covering [s, e) with
// unit price p and usage u amounts to p * u * (e - s), kept as an exact
// *big.Rat. The grand total is rounded to cents with round-half-to-even.
//
// Prices may be amended retroactively: SetPrice overrides any past or
// future interval, splitting existing segments at the amendment bounds.
// If any portion of the usage curve lacks a price, the whole billing run
// reports the uncovered half-open intervals in Result.Unpriced.
package billing

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// Interval is a half-open interval [Start, End) over integer ticks.
type Interval struct {
	Start int64
	End   int64
}

func (iv Interval) String() string { return fmt.Sprintf("[%d,%d)", iv.Start, iv.End) }

// segment is a half-open constant piece of a curve.
type segment[T any] struct {
	start int64
	end   int64
	val   T
}

// setSegment returns segs with [start, end) overridden by val, splitting
// existing segments at the override bounds. The result stays sorted and
// non-overlapping.
func setSegment[T any](segs []segment[T], start, end int64, val T) []segment[T] {
	if start >= end {
		panic("billing: empty interval")
	}
	out := make([]segment[T], 0, len(segs)+2)
	for _, s := range segs {
		if s.end <= start || s.start >= end {
			out = append(out, s)
			continue
		}
		if s.start < start {
			out = append(out, segment[T]{s.start, start, s.val})
		}
		if s.end > end {
			out = append(out, segment[T]{end, s.end, s.val})
		}
	}
	out = append(out, segment[T]{start, end, val})
	sort.Slice(out, func(i, j int) bool { return out[i].start < out[j].start })
	return out
}

// PriceBook holds piecewise-constant rational unit prices (per unit per tick).
type PriceBook struct {
	segs []segment[*big.Rat]
}

// SetPrice sets the unit price over [start, end), overriding whatever prices
// previously covered that interval. It applies to past intervals as well,
// which is how retroactive repricing is expressed.
func (b *PriceBook) SetPrice(start, end int64, price *big.Rat) {
	if price == nil {
		panic("billing: nil price")
	}
	b.segs = setSegment(b.segs, start, end, new(big.Rat).Set(price))
}

// PriceAt returns the unit price in effect at tick t.
func (b *PriceBook) PriceAt(t int64) (*big.Rat, bool) {
	i := sort.Search(len(b.segs), func(i int) bool { return b.segs[i].end > t })
	if i < len(b.segs) && b.segs[i].start <= t {
		return b.segs[i].val, true
	}
	return nil, false
}

// UsageCurve holds piecewise-constant integer usage (units per tick).
type UsageCurve struct {
	segs []segment[int64]
}

// SetUsage sets the usage level over [start, end), overriding prior values.
func (c *UsageCurve) SetUsage(start, end, units int64) {
	c.segs = setSegment(c.segs, start, end, units)
}

// UsageAt returns the usage in effect at tick t.
func (c *UsageCurve) UsageAt(t int64) (int64, bool) {
	i := sort.Search(len(c.segs), func(i int) bool { return c.segs[i].end > t })
	if i < len(c.segs) && c.segs[i].start <= t {
		return c.segs[i].val, true
	}
	return 0, false
}

// LineItem is one maximal constant piece of a bill: a half-open interval
// over which both unit price and usage are constant.
type LineItem struct {
	Interval  Interval
	Units     int64    // integer usage per tick
	UnitPrice *big.Rat // exact rational price per unit per tick
	Amount    *big.Rat // exact: UnitPrice * Units * (End - Start)
}

func (li LineItem) String() string {
	return fmt.Sprintf("%s units=%d price=%s amount=%s",
		li.Interval, li.Units, li.UnitPrice.RatString(), li.Amount.RatString())
}

// Result is the outcome of one billing run.
type Result struct {
	Items    []LineItem // exact fractional breakdown, in interval order
	Unpriced []Interval // merged half-open intervals with usage but no price
	Total    *big.Rat   // exact sum of Items
}

// Complete reports whether every tick of usage was priced.
func (r *Result) Complete() bool { return len(r.Unpriced) == 0 }

// TotalCents rounds the exact total to cents, ties to even.
func (r *Result) TotalCents() int64 { return RoundHalfEvenCents(r.Total) }

// Detail renders the exact fractional breakdown, one line per item, plus
// unpriced intervals and the rounded cent total.
func (r *Result) Detail() string {
	var sb strings.Builder
	for _, li := range r.Items {
		fmt.Fprintf(&sb, "item %s\n", li)
	}
	for _, iv := range r.Unpriced {
		fmt.Fprintf(&sb, "unpriced %s\n", iv)
	}
	fmt.Fprintf(&sb, "total=%s cents=%d (%s)\n",
		r.Total.RatString(), r.TotalCents(), FormatCents(r.TotalCents()))
	return sb.String()
}

// Bill prices the usage curve over the half-open window [start, end).
// Every priced piece becomes a LineItem with an exact rational amount;
// every tick of usage without a price is reported in Unpriced, so a run
// with missing prices is flagged as a whole via Result.Complete.
func Bill(pb *PriceBook, uc *UsageCurve, start, end int64) *Result {
	if start >= end {
		panic("billing: empty billing window")
	}
	res := &Result{Total: new(big.Rat)}
	for _, us := range uc.segs {
		s := max(us.start, start)
		e := min(us.end, end)
		if s >= e {
			continue
		}
		cursor := s
		for _, ps := range pb.segs {
			if ps.end <= cursor {
				continue
			}
			if ps.start >= e {
				break
			}
			if ps.start > cursor {
				res.Unpriced = append(res.Unpriced, Interval{cursor, min(ps.start, e)})
			}
			cs := max(cursor, ps.start)
			ce := min(ps.end, e)
			if cs < ce {
				amount := new(big.Rat).Mul(ps.val, big.NewRat(us.val*(ce-cs), 1))
				res.Items = append(res.Items, LineItem{
					Interval:  Interval{cs, ce},
					Units:     us.val,
					UnitPrice: new(big.Rat).Set(ps.val),
					Amount:    amount,
				})
				res.Total.Add(res.Total, amount)
			}
			cursor = ce
			if cursor >= e {
				break
			}
		}
		if cursor < e {
			res.Unpriced = append(res.Unpriced, Interval{cursor, e})
		}
	}
	res.Unpriced = mergeIntervals(res.Unpriced)
	return res
}

// mergeIntervals merges overlapping or adjacent half-open intervals.
func mergeIntervals(ivs []Interval) []Interval {
	if len(ivs) == 0 {
		return nil
	}
	sorted := append([]Interval(nil), ivs...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Start < sorted[j].Start })
	out := []Interval{sorted[0]}
	for _, iv := range sorted[1:] {
		last := &out[len(out)-1]
		if iv.Start <= last.End {
			last.End = max(last.End, iv.End)
		} else {
			out = append(out, iv)
		}
	}
	return out
}
