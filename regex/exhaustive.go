package regex

import "errors"

// This file contains an independent implementation of the match semantics
// used to cross-check the Pike VM: it enumerates every parse tree of the
// pattern by plain backtracking, then selects the winner by the rules
// (leftmost, then longest, then choice priority).

// errTooManyParses guards against pathological enumerations in tests.
var errTooManyParses = errors.New("too many parse trees")

const maxParses = 500000

// eparse is one complete parse tree of a node at some input position.
type eparse struct {
	end  int
	caps []int
	// prio records the branch choices made, in the order they occur:
	// 0 is the preferred branch (alternation: earlier branch; * and ?:
	// consume), 1 the fallback, and so on. Compared lexicographically.
	prio []int
}

type enumerator struct {
	s     string
	count int
}

func extendPrio(prio []int, choice int) []int {
	np := make([]int, len(prio)+1)
	copy(np, prio)
	np[len(prio)] = choice
	return np
}

// enum returns every parse of n starting at pos. caps is never mutated;
// updated copies are stored in the results.
func (e *enumerator) enum(n *node, pos int, caps []int, prio []int) ([]eparse, error) {
	e.count++
	if e.count > maxParses {
		return nil, errTooManyParses
	}
	switch n.kind {
	case kLit:
		if pos < len(e.s) && e.s[pos] == n.c {
			return []eparse{{end: pos + 1, caps: caps, prio: prio}}, nil
		}
		return nil, nil
	case kConcat:
		results := []eparse{{end: pos, caps: caps, prio: prio}}
		for _, c := range n.children {
			var next []eparse
			for _, r := range results {
				sub, err := e.enum(c, r.end, r.caps, r.prio)
				if err != nil {
					return nil, err
				}
				next = append(next, sub...)
			}
			results = next
			if len(results) == 0 {
				break
			}
		}
		return results, nil
	case kAlt:
		var out []eparse
		for i, b := range n.children {
			sub, err := e.enum(b, pos, caps, extendPrio(prio, i))
			if err != nil {
				return nil, err
			}
			out = append(out, sub...)
		}
		return out, nil
	case kQuest:
		out, err := e.enum(n.children[0], pos, caps, extendPrio(prio, 0))
		if err != nil {
			return nil, err
		}
		return append(out, eparse{end: pos, caps: caps, prio: extendPrio(prio, 1)}), nil
	case kStar:
		// Zero iterations: exit the loop immediately.
		out := []eparse{{end: pos, caps: caps, prio: extendPrio(prio, 1)}}
		body, err := e.enum(n.children[0], pos, caps, extendPrio(prio, 0))
		if err != nil {
			return nil, err
		}
		for _, bp := range body {
			if bp.end == pos {
				// An empty iteration terminates the loop and its
				// captures are discarded (the thread dies), exactly
				// like the Pike VM's visited-set behaves.
				continue
			}
			rest, err := e.enum(n, bp.end, bp.caps, bp.prio)
			if err != nil {
				return nil, err
			}
			out = append(out, rest...)
		}
		return out, nil
	case kGroup:
		sub, err := e.enum(n.children[0], pos, caps, prio)
		if err != nil {
			return nil, err
		}
		for i := range sub {
			nc := make([]int, len(sub[i].caps))
			copy(nc, sub[i].caps)
			nc[2*n.groupIdx] = pos
			nc[2*n.groupIdx+1] = sub[i].end
			sub[i].caps = nc
		}
		return sub, nil
	}
	panic("unreachable")
}

// lessPrio reports whether choice sequence a has higher priority than b.
func lessPrio(a, b []int) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) > len(b)
}

// findExhaustive is the reference matcher: it tries every start offset
// from left to right, enumerates all parse trees, and picks the longest,
// breaking ties by choice priority.
func (re *Regexp) findExhaustive(s string) ([]int, bool, error) {
	for start := 0; start <= len(s); start++ {
		caps0 := make([]int, 2*re.ngroups)
		for i := range caps0 {
			caps0[i] = -1
		}
		caps0[0] = start
		e := &enumerator{s: s}
		parses, err := e.enum(re.ast, start, caps0, nil)
		if err != nil {
			return nil, false, err
		}
		if len(parses) == 0 {
			continue
		}
		best := parses[0]
		for _, p := range parses[1:] {
			if p.end > best.end || (p.end == best.end && lessPrio(p.prio, best.prio)) {
				best = p
			}
		}
		caps := make([]int, len(best.caps))
		copy(caps, best.caps)
		caps[1] = best.end
		return caps, true, nil
	}
	return nil, false, nil
}
