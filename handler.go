// Package bchandler validates half-open protected bytecode intervals and
// computes the effective handler chain per instruction.
//
// Semantics:
//   - Each handler protects a half-open interval [Start, End) of instruction
//     indices.
//   - Intervals must be laminar: any two intervals are disjoint or one
//     contains the other. Crossing (partially overlapping) intervals are
//     rejected by ValidateHandlers.
//   - The effective handler chain at an instruction lists every handler
//     covering it, innermost interval first; handlers on the same level
//     (identical intervals) are ordered by ascending declaration index.
package bchandler

import (
	"fmt"
	"sort"
)

// Handler is a protected half-open interval [Start, End) over instruction
// indices, with an optional caught exception Type.
type Handler struct {
	Name  string
	Start int // inclusive
	End   int // exclusive
	Type  string
	Order int // declaration index, assigned by LoadSpec / NewHandlers
}

// Covers reports whether pc lies in [h.Start, h.End).
func (h Handler) Covers(pc int) bool { return h.Start <= pc && pc < h.End }

// Len returns the number of instructions the interval spans.
func (h Handler) Len() int { return h.End - h.Start }

// NewHandlers assigns declaration indices in input order.
func NewHandlers(hs []Handler) []Handler {
	out := make([]Handler, len(hs))
	for i, h := range hs {
		h.Order = i
		out[i] = h
	}
	return out
}

// ValidateHandlers checks interval bounds and rejects crossing intervals.
// codeLen is the number of instructions; every interval must satisfy
// 0 <= Start < End <= codeLen.
func ValidateHandlers(hs []Handler, codeLen int) error {
	if codeLen < 0 {
		return fmt.Errorf("negative code length %d", codeLen)
	}
	for i, h := range hs {
		if h.Start < 0 || h.Start >= h.End {
			return fmt.Errorf("handler %d (%q): invalid half-open interval [%d,%d)", i, h.Name, h.Start, h.End)
		}
		if h.End > codeLen {
			return fmt.Errorf("handler %d (%q): end %d exceeds code length %d", i, h.Name, h.End, codeLen)
		}
	}
	for i := 0; i < len(hs); i++ {
		for j := i + 1; j < len(hs); j++ {
			if crossing(hs[i], hs[j]) {
				return fmt.Errorf("handlers %d (%q) [%d,%d) and %d (%q) [%d,%d) cross without nesting",
					i, hs[i].Name, hs[i].Start, hs[i].End,
					j, hs[j].Name, hs[j].Start, hs[j].End)
			}
		}
	}
	return nil
}

// crossing reports whether a and b overlap without one containing the other.
func crossing(a, b Handler) bool {
	overlap := a.Start < b.End && b.Start < a.End
	if !overlap {
		return false
	}
	aContainsB := a.Start <= b.Start && b.End <= a.End
	bContainsA := b.Start <= a.Start && a.End <= b.End
	return !aContainsB && !bContainsA
}

// higherPriority reports whether a precedes b in an effective chain:
// the inner (shorter) interval wins; equal-length intervals (identical in a
// valid laminar set) are ordered by ascending declaration index.
func higherPriority(a, b Handler) bool {
	if a.Len() != b.Len() {
		return a.Len() < b.Len()
	}
	return a.Order < b.Order
}

// ChainReference computes the effective handler chain at pc by scanning every
// interval. It is the straightforward reference implementation used to
// cross-check Chain.
func ChainReference(hs []Handler, pc int) []Handler {
	var chain []Handler
	for _, h := range hs {
		if h.Covers(pc) {
			chain = append(chain, h)
		}
	}
	sort.Slice(chain, func(i, j int) bool { return higherPriority(chain[i], chain[j]) })
	return chain
}

// node is a vertex of the containment forest built from a laminar set.
type node struct {
	h        Handler
	children []*node
}

// BuildForest nests a validated laminar handler set into a containment
// forest: parents strictly contain their children; siblings are disjoint.
func BuildForest(hs []Handler) []*node {
	idx := make([]int, len(hs))
	for i := range idx {
		idx[i] = i
	}
	sort.Slice(idx, func(i, j int) bool {
		a, b := hs[idx[i]], hs[idx[j]]
		if a.Start != b.Start {
			return a.Start < b.Start
		}
		if a.End != b.End {
			return a.End > b.End
		}
		return a.Order < b.Order
	})
	var roots []*node
	var stack []*node
	for _, id := range idx {
		n := &node{h: hs[id]}
		for len(stack) > 0 && stack[len(stack)-1].h.End <= n.h.Start {
			stack = stack[:len(stack)-1]
		}
		if len(stack) == 0 {
			roots = append(roots, n)
		} else {
			top := stack[len(stack)-1]
			top.children = append(top.children, n)
		}
		stack = append(stack, n)
	}
	return roots
}

// Chain computes the effective handler chain at pc by descending the
// containment forest. In a laminar set the handlers covering pc are exactly
// the ancestors of the deepest node covering pc, so a single root-to-leaf
// walk finds them all; the path is then ordered by priority.
func Chain(forest []*node, pc int) []Handler {
	var path []Handler
	level := forest
	for {
		var next *node
		for _, n := range level {
			if n.h.Covers(pc) {
				next = n
				break
			}
		}
		if next == nil {
			break
		}
		path = append(path, next.h)
		level = next.children
	}
	sort.Slice(path, func(i, j int) bool { return higherPriority(path[i], path[j]) })
	return path
}

// InsertInstructions remaps handler endpoints after count instructions are
// inserted before index at. The inserted instructions occupy [at, at+count).
//
// Remap rules for a half-open interval [s, e):
//   - s >= at  -> s += count (a handler starting at the insertion point does
//     not cover the new instructions)
//   - e >  at  -> e += count (a handler ending at the insertion point does
//     not cover them either)
//
// Consequently an interval with s < at < e expands to cover the inserted
// instructions; all other intervals keep their original coverage of the old
// instructions. The transform is endpoint-monotone, so a laminar set stays
// laminar.
func InsertInstructions(hs []Handler, at, count int) ([]Handler, error) {
	if at < 0 {
		return nil, fmt.Errorf("insert position %d is negative", at)
	}
	if count < 0 {
		return nil, fmt.Errorf("insert count %d is negative", count)
	}
	out := make([]Handler, len(hs))
	for i, h := range hs {
		nh := h
		if h.Start >= at {
			nh.Start += count
		}
		if h.End > at {
			nh.End += count
		}
		out[i] = nh
	}
	return out, nil
}
