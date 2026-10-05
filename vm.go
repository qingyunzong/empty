package searchre

// Regexp is a compiled pattern. It is safe for concurrent use.
type Regexp struct {
	src     string
	p       *prog
	ngroups int
}

// Compile parses pattern and returns a Regexp.
//
// Supported syntax: literal characters, escape with '\', groups '(...)',
// alternation 'a|b', and the postfix quantifiers '*' and '?'.
//
// Match semantics: leftmost-earliest, then longest; ties between matches of
// equal span are resolved by alternation branch order (earlier branch wins,
// quantifiers are greedy). A capture group reports the text of the final
// iteration in which it participated, including a final empty iteration
// (an empty iteration that would repeat an identical state is cut, so
// empty loops always terminate).
func Compile(pattern string) (*Regexp, error) {
	ast, ngroups, err := parse(pattern)
	if err != nil {
		return nil, err
	}
	return &Regexp{src: pattern, p: compile(ast, ngroups), ngroups: ngroups}, nil
}

// MustCompile is like Compile but panics on error.
func MustCompile(pattern string) *Regexp {
	re, err := Compile(pattern)
	if err != nil {
		panic(err)
	}
	return re
}

// NumGroups returns the number of capture groups.
func (re *Regexp) NumGroups() int { return re.ngroups }

// String returns the source pattern.
func (re *Regexp) String() string { return re.src }

type thread struct {
	pc   int
	caps []int
}

// stateKey identifies a thread state for deduplication: two threads at
// the same program counter with identical captures are equivalent, and
// only the first (highest-priority) one is kept.
type stateKey struct {
	pc   int
	caps string
}

// capsString encodes capture slots (-1 and positions) as 4-byte values.
func capsString(caps []int) string {
	b := make([]byte, 0, len(caps)*4)
	for _, v := range caps {
		u := uint32(v + 1)
		b = append(b, byte(u), byte(u>>8), byte(u>>16), byte(u>>24))
	}
	return string(b)
}

// matchAt finds the longest match anchored exactly at start (rune index).
// Among matches with the same end, the highest-priority thread (alternation
// branch order, greedy quantifiers) determines the captures.
func (re *Regexp) matchAt(s []rune, start int) ([]int, bool) {
	code := re.p.code
	ncaps := 2 * (re.ngroups + 1)
	init := make([]int, ncaps)
	for i := range init {
		init[i] = -1
	}

	// seen holds fully explored states, which can be cut safely: their
	// emissions are complete. onPath holds states on the current
	// exploration stack (ancestors); they are re-entered transparently
	// because a backtracking engine would also walk through them again
	// on its way to a loop guard. Only opLoop cuts ancestors, which
	// guarantees termination: every inputless cycle passes a loop head.
	seen := map[stateKey]bool{}
	onPath := map[stateKey]bool{}
	cur := start      // input position of the threads being added
	var out *[]thread // list add() appends to
	var add func(pc int, caps []int)
	add = func(pc int, caps []int) {
		key := stateKey{pc: pc, caps: capsString(caps)}
		if seen[key] {
			return
		}
		ancestor := onPath[key]
		if !ancestor {
			onPath[key] = true
		}
		in := code[pc]
		switch in.op {
		case opJmp:
			add(in.x, caps)
		case opSplit:
			add(in.x, caps)
			add(in.y, caps)
		case opLoop:
			// Loop back to the head unless this exact state was
			// already visited on this path or completed (an empty
			// iteration made no progress); in that case leave the
			// loop instead, like the backtracking checker's guard.
			head := stateKey{pc: in.x, caps: key.caps}
			if onPath[head] || seen[head] {
				add(in.y, caps)
			} else {
				add(in.x, caps)
			}
		case opSave:
			nc := make([]int, len(caps))
			copy(nc, caps)
			nc[in.slot] = cur
			add(pc+1, nc)
		default: // opChar, opMatch
			*out = append(*out, thread{pc: pc, caps: caps})
		}
		if !ancestor {
			delete(onPath, key)
			seen[key] = true
		}
	}

	clist := []thread{}
	out = &clist
	add(0, init)

	var best []int
	for pos := start; ; pos++ {
		// The first Match-thread in list order is the highest-priority
		// match ending at pos. Longer matches overwrite shorter ones.
		for _, t := range clist {
			if code[t.pc].op == opMatch {
				best = t.caps
				break
			}
		}
		if pos >= len(s) || len(clist) == 0 {
			break
		}
		seen = map[stateKey]bool{}
		onPath = map[stateKey]bool{}
		nlist := []thread{}
		out = &nlist
		cur = pos + 1
		for _, t := range clist {
			if in := code[t.pc]; in.op == opChar && in.ch == s[pos] {
				add(t.pc+1, t.caps)
			}
		}
		clist = nlist
	}
	if best == nil {
		return nil, false
	}
	return best, true
}

// FindIndex returns the rune offsets [start, end) of the leftmost-longest
// match, or nil if there is no match.
func (re *Regexp) FindIndex(s string) []int {
	caps := re.findCaps([]rune(s))
	if caps == nil {
		return nil
	}
	return []int{caps[0], caps[1]}
}

// FindSubmatchIndex returns rune offsets for the whole match and each
// capture group: [m0s, m0e, g1s, g1e, ...]. Groups that did not
// participate have offsets -1. Returns nil if there is no match.
func (re *Regexp) FindSubmatchIndex(s string) []int {
	caps := re.findCaps([]rune(s))
	if caps == nil {
		return nil
	}
	out := make([]int, len(caps))
	copy(out, caps)
	return out
}

// Find returns the matched text, or "" if there is no match.
func (re *Regexp) Find(s string) string {
	r := []rune(s)
	caps := re.findCaps(r)
	if caps == nil {
		return ""
	}
	return string(r[caps[0]:caps[1]])
}

// FindSubmatch returns the match followed by each capture group's text.
// Non-participating groups yield "". Returns nil if there is no match.
func (re *Regexp) FindSubmatch(s string) []string {
	r := []rune(s)
	caps := re.findCaps(r)
	if caps == nil {
		return nil
	}
	out := make([]string, re.ngroups+1)
	for g := 0; g <= re.ngroups; g++ {
		if caps[2*g] >= 0 {
			out[g] = string(r[caps[2*g]:caps[2*g+1]])
		}
	}
	return out
}

// findCaps returns the leftmost-longest match capture slots, or nil.
func (re *Regexp) findCaps(s []rune) []int {
	for start := 0; start <= len(s); start++ {
		if caps, ok := re.matchAt(s, start); ok {
			return caps
		}
	}
	return nil
}
