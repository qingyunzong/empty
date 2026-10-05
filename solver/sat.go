package solver

// This file implements a small CDCL SAT solver with:
//   - two watched literals and 1-UIP clause learning,
//   - package-level decision heuristic (highest version first),
//   - a cardinality bound on designated "change" variables, enforced by
//     treating bound violations as conflicts (the negated true change
//     variables form the conflicting clause, which is then analyzed and
//     learned from like any other conflict).
//
// Literals are non-zero ints; v means variable v, -v its negation.

type cdcl struct {
	nvars      int
	clauses    [][]int
	watches    [][]int // watchIndex(lit) -> clause ids watching lit
	assign     []int8  // 0 unassigned, 1 true, -1 false
	level      []int
	reason     []int // clause id, -1 = decision or level-0 unit
	trail      []int
	qhead      int
	dlevel     int
	isChange   []bool
	maxChanges int
	pkgVars    [][]int // decision order: packages, vars in rank order
}

func watchIndex(lit int) int {
	if lit > 0 {
		return 2 * lit
	}
	return -2*lit + 1
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// solveClauses runs CDCL and returns (true, assignment) or (false, nil).
// maxChanges < 0 means unbounded.
func solveClauses(base [][]int, nvars int, assumptions []int, changeVars []int, maxChanges int, pkgVars [][]int) (bool, []int8) {
	if maxChanges < 0 {
		maxChanges = nvars
	}
	s := &cdcl{
		nvars:      nvars,
		watches:    make([][]int, 2*(nvars+1)),
		assign:     make([]int8, nvars+1),
		level:      make([]int, nvars+1),
		reason:     make([]int, nvars+1),
		isChange:   make([]bool, nvars+1),
		maxChanges: maxChanges,
		pkgVars:    pkgVars,
	}
	for _, cv := range changeVars {
		s.isChange[cv] = true
	}
	s.clauses = make([][]int, 0, len(base)+len(assumptions))
	for _, cl := range base {
		if len(cl) == 0 {
			return false, nil
		}
		if len(cl) == 1 {
			if !s.enqueue(cl[0], -1) {
				return false, nil
			}
			continue
		}
		cp := make([]int, len(cl))
		copy(cp, cl)
		s.addClause(cp)
	}
	for _, a := range assumptions {
		if !s.enqueue(a, -1) {
			return false, nil
		}
	}
	if s.solve() {
		return true, s.assign
	}
	return false, nil
}

func (s *cdcl) addClause(cl []int) int {
	id := len(s.clauses)
	s.clauses = append(s.clauses, cl)
	s.watches[watchIndex(cl[0])] = append(s.watches[watchIndex(cl[0])], id)
	s.watches[watchIndex(cl[1])] = append(s.watches[watchIndex(cl[1])], id)
	return id
}

func (s *cdcl) valueOf(lit int) int8 {
	a := s.assign[abs(lit)]
	if a == 0 {
		return 0
	}
	if (lit > 0) == (a == 1) {
		return 1
	}
	return -1
}

func (s *cdcl) enqueue(lit, reason int) bool {
	v := abs(lit)
	want := int8(1)
	if lit < 0 {
		want = -1
	}
	if s.assign[v] != 0 {
		return s.assign[v] == want
	}
	s.assign[v] = want
	s.level[v] = s.dlevel
	s.reason[v] = reason
	s.trail = append(s.trail, lit)
	return true
}

// propagate runs unit propagation to a fixpoint, then checks the change
// bound. Returns a conflicting clause (owned by the solver or freshly
// built for the bound) or nil.
func (s *cdcl) propagate() []int {
	for s.qhead < len(s.trail) {
		lit := s.trail[s.qhead]
		s.qhead++
		wi := watchIndex(-lit)
		wl := s.watches[wi]
		kept := wl[:0]
		i := 0
		for ; i < len(wl); i++ {
			ci := wl[i]
			cl := s.clauses[ci]
			if cl[0] == -lit {
				cl[0], cl[1] = cl[1], cl[0]
			}
			if s.valueOf(cl[0]) == 1 {
				kept = append(kept, ci)
				continue
			}
			found := false
			for k := 2; k < len(cl); k++ {
				if s.valueOf(cl[k]) != -1 {
					cl[1], cl[k] = cl[k], cl[1]
					s.watches[watchIndex(cl[1])] = append(s.watches[watchIndex(cl[1])], ci)
					found = true
					break
				}
			}
			if found {
				continue
			}
			kept = append(kept, ci)
			if s.valueOf(cl[0]) == -1 {
				// Conflict: keep the unprocessed remainder untouched.
				s.watches[wi] = append(kept, wl[i+1:]...)
				return cl
			}
			s.enqueue(cl[0], ci)
		}
		s.watches[wi] = kept
	}
	cnt := 0
	var pseudo []int
	for v := 1; v <= s.nvars; v++ {
		if s.isChange[v] && s.assign[v] == 1 {
			cnt++
			pseudo = append(pseudo, -v)
		}
	}
	if cnt > s.maxChanges {
		return pseudo
	}
	return nil
}

// analyze performs 1-UIP conflict analysis, returning the learned clause
// (learnt[0] is the asserting literal) and the backjump level.
func (s *cdcl) analyze(confl []int) (learnt []int, bt int) {
	seen := make([]bool, s.nvars+1)
	learnt = []int{0} // placeholder for the asserting literal
	pathC := 0
	var p int
	c := confl
	isReason := false // reason clauses keep the implied literal at index 0
	ti := len(s.trail) - 1
	for {
		start := 0
		if isReason {
			start = 1
		}
		for _, q := range c[start:] {
			v := abs(q)
			if !seen[v] && s.level[v] > 0 {
				seen[v] = true
				if s.level[v] == s.dlevel {
					pathC++
				} else {
					learnt = append(learnt, q)
				}
			}
		}
		for {
			p = s.trail[ti]
			ti--
			if seen[abs(p)] {
				break
			}
		}
		seen[abs(p)] = false
		pathC--
		if pathC == 0 {
			break
		}
		c = s.clauses[s.reason[abs(p)]]
		isReason = true
	}
	learnt[0] = -p
	bt = 0
	if len(learnt) > 1 {
		maxIdx := 1
		for i := 1; i < len(learnt); i++ {
			if l := s.level[abs(learnt[i])]; l > bt {
				bt = l
				maxIdx = i
			}
		}
		learnt[1], learnt[maxIdx] = learnt[maxIdx], learnt[1]
	}
	return learnt, bt
}

func (s *cdcl) backtrack(bt int) {
	for len(s.trail) > 0 && s.level[abs(s.trail[len(s.trail)-1])] > bt {
		v := abs(s.trail[len(s.trail)-1])
		s.trail = s.trail[:len(s.trail)-1]
		s.assign[v] = 0
		s.level[v] = 0
		s.reason[v] = -1
	}
	if s.qhead > len(s.trail) {
		s.qhead = len(s.trail)
	}
	s.dlevel = bt
}

// pickDecision picks the first undecided package's highest available
// version. Returns 0 when every package is decided.
func (s *cdcl) pickDecision() int {
	for _, vars := range s.pkgVars {
		decided := false
		cand := 0
		for _, x := range vars {
			switch s.assign[x] {
			case 1:
				decided = true
			case 0:
				if cand == 0 {
					cand = x
				}
			}
		}
		if !decided && cand != 0 {
			return cand
		}
	}
	return 0
}

func (s *cdcl) solve() bool {
	for {
		if confl := s.propagate(); confl != nil {
			if s.dlevel == 0 {
				return false
			}
			learnt, bt := s.analyze(confl)
			s.backtrack(bt)
			if len(learnt) == 1 {
				s.enqueue(learnt[0], -1)
			} else {
				ci := s.addClause(learnt)
				s.enqueue(learnt[0], ci)
			}
			continue
		}
		lit := s.pickDecision()
		if lit == 0 {
			// Only change variables may remain unassigned; they occur
			// only positively, so assigning them false keeps every
			// clause satisfied.
			for v := 1; v <= s.nvars; v++ {
				if s.assign[v] == 0 {
					s.assign[v] = -1
				}
			}
			return true
		}
		s.dlevel++
		s.enqueue(lit, -1)
	}
}
