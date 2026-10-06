// Package ranges models bytecode protected (try) ranges as half-open
// instruction intervals [Start, End) and computes the effective handler
// chain for every instruction.
//
// Priority rules:
//   - inner (more deeply nested) ranges win over outer ranges;
//   - among ranges with identical span, the one declared earlier
//     (smaller Order) wins.
//
// Ranges that overlap without one containing the other ("crossing")
// are rejected by Validate.
package ranges

import (
	"fmt"
	"sort"
)

// Range is a half-open protected interval [Start, End) of instruction
// indices, guarded by Handler. Order is the declaration index used as
// the tie-breaker among same-span ranges.
type Range struct {
	Start   int    `json:"start"`
	End     int    `json:"end"`
	Handler string `json:"handler"`
	Order   int    `json:"-"`
}

func (r Range) contains(pc int) bool { return r.Start <= pc && pc < r.End }

func (r Range) span() int { return r.End - r.Start }

// containsRange reports whether r fully contains o.
func (r Range) containsRange(o Range) bool {
	return r.Start <= o.Start && o.End <= r.End
}

func overlaps(a, b Range) bool { return a.Start < b.End && b.Start < a.End }

// Validate checks every range for sane bounds and rejects any pair of
// ranges that overlap without nesting.
func Validate(rs []Range) error {
	for i, r := range rs {
		if r.Start < 0 {
			return fmt.Errorf("range %d (%s): negative start %d", i, r.Handler, r.Start)
		}
		if r.Start >= r.End {
			return fmt.Errorf("range %d (%s): empty or inverted interval [%d, %d)", i, r.Handler, r.Start, r.End)
		}
	}
	for i := 0; i < len(rs); i++ {
		for j := i + 1; j < len(rs); j++ {
			a, b := rs[i], rs[j]
			if overlaps(a, b) && !a.containsRange(b) && !b.containsRange(a) {
				return fmt.Errorf("crossing ranges: [%d,%d) %s and [%d,%d) %s overlap without nesting",
					a.Start, a.End, a.Handler, b.Start, b.End, b.Handler)
			}
		}
	}
	return nil
}

// chainLess orders ranges for a handler chain: inner (smaller span)
// first, then smaller declaration order.
func chainLess(a, b Range) bool {
	if a.span() != b.span() {
		return a.span() < b.span()
	}
	return a.Order < b.Order
}

// Table is a precomputed index for fast per-instruction chain queries.
type Table struct {
	sorted []Range // sorted by Start, then by decreasing End (outer first)
}

// NewTable validates rs and builds a query index. Declaration order is
// captured from the slice order when Order is left as the zero value;
// callers may set Order explicitly beforehand — use WithOrder to be safe.
func NewTable(rs []Range) (*Table, error) {
	rs = WithOrder(rs)
	if err := Validate(rs); err != nil {
		return nil, err
	}
	sorted := make([]Range, len(rs))
	copy(sorted, rs)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Start != sorted[j].Start {
			return sorted[i].Start < sorted[j].Start
		}
		return sorted[i].End > sorted[j].End
	})
	return &Table{sorted: sorted}, nil
}

// WithOrder returns a copy of rs with Order set to the slice index.
func WithOrder(rs []Range) []Range {
	out := make([]Range, len(rs))
	copy(out, rs)
	for i := range out {
		out[i].Order = i
	}
	return out
}

// ChainAt returns the effective handler chain for the instruction at pc,
// innermost handler first.
func (t *Table) ChainAt(pc int) []Range {
	var chain []Range
	for _, r := range t.sorted {
		if r.Start > pc {
			break
		}
		if r.contains(pc) {
			chain = append(chain, r)
		}
	}
	sort.Slice(chain, func(i, j int) bool { return chainLess(chain[i], chain[j]) })
	return chain
}

// ReferenceChainAt is the naive per-range scan used to cross-check
// Table.ChainAt: every range is tested independently against pc.
func ReferenceChainAt(rs []Range, pc int) []Range {
	var chain []Range
	for _, r := range rs {
		if r.contains(pc) {
			chain = append(chain, r)
		}
	}
	sort.Slice(chain, func(i, j int) bool { return chainLess(chain[i], chain[j]) })
	return chain
}

// Remap shifts range endpoints after count instructions have been
// inserted at position at. Endpoints move exactly like the instructions
// they delimit: an endpoint p moves to p+count iff the instruction it
// borders moved, i.e. Start moves when Start >= at, End moves when
// End > at. Consequently instructions inserted strictly inside a range
// become protected by it, while insertion at a boundary leaves the new
// instructions outside the range.
func Remap(rs []Range, at, count int) []Range {
	out := make([]Range, len(rs))
	for i, r := range rs {
		if r.Start >= at {
			r.Start += count
		}
		if r.End > at {
			r.End += count
		}
		out[i] = r
	}
	return out
}
