// Package regex implements a small regular-expression engine supporting
// literals, grouping, alternation, star and question mark.
//
// Match semantics:
//   - leftmost-earliest: the match starts at the smallest possible offset;
//   - longest: among matches at that offset, the longest one wins;
//   - ties (same span, several parse trees) are broken by the priority of
//     the choices made: earlier alternation branches are preferred, and
//     * / ? prefer consuming over skipping;
//   - a capture group reports the last iteration that participated in the
//     final match; a group that never participated reports -1, -1;
//   - a * loop never performs an empty iteration (an iteration matching the
//     empty string terminates the loop, as in RE2/Go's regexp).
package regex

// Regexp is a compiled pattern.
type Regexp struct {
	ast     *node
	prog    *prog
	ngroups int
}

// Compile parses and compiles pattern.
func Compile(pattern string) (*Regexp, error) {
	n, ng, err := parse(pattern)
	if err != nil {
		return nil, err
	}
	return &Regexp{ast: n, prog: compile(n), ngroups: ng}, nil
}

// NumGroups returns the number of capture groups, including group 0 (the
// whole match).
func (re *Regexp) NumGroups() int { return re.ngroups }

// Find returns the capture spans of the leftmost-longest match in s as a
// slice of 2*NumGroups() offsets: caps[2*i] and caps[2*i+1] are the start
// and end of group i, or -1, -1 if the group did not participate.
// ok is false when there is no match.
func (re *Regexp) Find(s string) (caps []int, ok bool) {
	for start := 0; start <= len(s); start++ {
		if caps, ok := re.matchAt(s, start); ok {
			return caps, true
		}
	}
	return nil, false
}

type thread struct {
	pc   int
	caps []int
}

// addThread follows jmp/split/save instructions in priority order and
// appends every reached char/match instruction to list. Each program
// counter is visited at most once per input position; the first (highest
// priority) visit wins.
func (re *Regexp) addThread(list []thread, visited []bool, pc int, caps []int, pos int) []thread {
	if visited[pc] {
		return list
	}
	visited[pc] = true
	in := re.prog.code[pc]
	switch in.op {
	case opJmp:
		return re.addThread(list, visited, in.x, caps, pos)
	case opSplit:
		list = re.addThread(list, visited, in.x, caps, pos)
		return re.addThread(list, visited, in.y, caps, pos)
	case opSave:
		nc := make([]int, len(caps))
		copy(nc, caps)
		nc[in.slot] = pos
		return re.addThread(list, visited, pc+1, nc, pos)
	}
	return append(list, thread{pc: pc, caps: caps})
}

// matchAt runs the Pike VM anchored at start and reports the longest match
// starting there; among matches of equal length the highest-priority one
// (alternation branch order, greedy loops) wins.
func (re *Regexp) matchAt(s string, start int) ([]int, bool) {
	code := re.prog.code
	caps0 := make([]int, 2*re.ngroups)
	for i := range caps0 {
		caps0[i] = -1
	}
	clist := re.addThread(nil, make([]bool, len(code)), 0, caps0, start)
	var matched []int
	for i := start; len(clist) > 0; i++ {
		var stepMatch []int
		var nlist []thread
		nvisited := make([]bool, len(code))
		for _, t := range clist {
			in := code[t.pc]
			switch in.op {
			case opChar:
				if i < len(s) && s[i] == in.c {
					nlist = re.addThread(nlist, nvisited, t.pc+1, t.caps, i+1)
				}
			case opMatch:
				if stepMatch == nil {
					stepMatch = t.caps
				}
			}
		}
		if stepMatch != nil {
			matched = stepMatch
		}
		if i >= len(s) {
			break
		}
		clist = nlist
	}
	if matched == nil {
		return nil, false
	}
	return matched, true
}
