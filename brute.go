package searchre

import "fmt"

// brute.go is an independent, exhaustive backtracking matcher used to
// cross-check the NFA engine. It walks the AST directly (no compiled
// program) and enumerates every possible match in priority order:
// alternation branches are tried in source order and quantifiers are
// greedy. The leftmost-longest result is then derived from the
// enumeration: earliest start, then largest end, then first enumerated.

type visitKey struct {
	nodeID int
	pos    int
	caps   string
}

type brute struct {
	s []rune
	// budget bounds the enumeration work; it is decremented on every
	// recursive step and panics with errExhausted when it runs out.
	// Exhaustive enumeration of nested nullable stars is exponential,
	// so callers use a budget as a safety valve.
	budget int
}

var errExhausted = fmt.Errorf("searchre: brute-force budget exhausted")

// bruteForce returns the leftmost-longest match capture slots for the
// pattern, or nil. It re-parses the pattern itself. If the enumeration
// exceeds its step budget it returns exhausted=true.
func bruteForce(pattern string, s []rune) (caps []int, ok bool, exhausted bool) {
	ast, ngroups, err := parse(pattern)
	if err != nil {
		return nil, false, false
	}
	b := &brute{s: s, budget: 1 << 16}
	defer func() {
		if r := recover(); r != nil {
			if r == errExhausted {
				caps, ok, exhausted = nil, false, true
				return
			}
			panic(r)
		}
	}()
	ncaps := 2 * (ngroups + 1)
	for start := 0; start <= len(s); start++ {
		var best []int
		bestEnd := -1
		b.enumerate(ast, start, start, ncaps, func(end int, caps []int) {
			if end > bestEnd { // first enumerated wins ties
				bestEnd = end
				best = caps
			}
		})
		if best != nil {
			return best, true, false
		}
	}
	return nil, false, false
}

// enumerate calls emit(end, caps) for every way n (anchored at pos) can
// match a prefix of s[pos:], in priority order.
func (b *brute) enumerate(n *node, pos, start int, ncaps int, emit func(int, []int)) {
	init := make([]int, ncaps)
	for i := range init {
		init[i] = -1
	}
	init[0] = start
	path := map[visitKey]bool{}
	b.match(n, pos, init, path, func(end int, caps []int) {
		nc := copyCaps(caps)
		nc[1] = end
		emit(end, nc)
	})
}

func copyCaps(c []int) []int {
	nc := make([]int, len(c))
	copy(nc, c)
	return nc
}

// match calls k(end, caps) for every way n can match starting at pos.
// path guards against unbounded iteration of a star whose body matched
// the empty string at the same position.
func (b *brute) match(n *node, pos int, caps []int, path map[visitKey]bool, k func(int, []int)) {
	if b.budget--; b.budget < 0 {
		panic(errExhausted)
	}
	switch n.kind {
	case kEmpty:
		k(pos, caps)
	case kChar:
		if pos < len(b.s) && b.s[pos] == n.ch {
			k(pos+1, caps)
		}
	case kConcat:
		b.matchSeq(n.kids, 0, pos, caps, path, k)
	case kAlt:
		for _, branch := range n.kids {
			b.match(branch, pos, caps, path, k)
		}
	case kQuest:
		b.match(n.sub, pos, caps, path, k) // greedy: try matching first
		k(pos, caps)
	case kStar:
		b.matchStar(n, pos, caps, path, k)
	case kGroup:
		inner := copyCaps(caps)
		inner[2*n.gid] = pos
		b.match(n.sub, pos, inner, path, func(end int, c []int) {
			nc := copyCaps(c)
			nc[2*n.gid+1] = end
			k(end, nc)
		})
	}
}

func (b *brute) matchSeq(kids []*node, i, pos int, caps []int, path map[visitKey]bool, k func(int, []int)) {
	if i == len(kids) {
		k(pos, caps)
		return
	}
	b.match(kids[i], pos, caps, path, func(end int, c []int) {
		b.matchSeq(kids, i+1, end, c, path, k)
	})
}

func (b *brute) matchStar(n *node, pos int, caps []int, path map[visitKey]bool, k func(int, []int)) {
	// A star may iterate while it makes progress; an empty iteration
	// is allowed, but re-entering the same star at the same position
	// with the same captures would loop forever, so that path is cut
	// and the star simply exits. This mirrors the NFA engine, which
	// dedupes threads by (pc, captures).
	key := visitKey{nodeID: n.id, pos: pos, caps: capsString(caps)}
	if !path[key] {
		path[key] = true
		b.match(n.sub, pos, caps, path, func(end int, c []int) {
			b.matchStar(n, end, c, path, k) // greedy: iterate first
		})
		delete(path, key)
	}
	k(pos, caps)
}
