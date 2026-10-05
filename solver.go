package contractopt

import "sort"

// BoundEvidence accompanies a Result: RevenueLower is the revenue achieved
// by the returned allocation (a certified lower bound on the optimum),
// RevenueUpper is a relaxation upper bound valid for every feasible
// allocation (locked revenue plus the MaxContracts-#locked highest positive
// revenues of the remaining contracts).
type BoundEvidence struct {
	RevenueLower int64
	RevenueUpper int64
}

// Result is the outcome of Solve: an optimal allocation together with its
// objective values, a dependency certificate, and bound evidence.
type Result struct {
	Alloc   Allocation
	Revenue int64       // maximized total revenue
	Usage   int64       // minimized total resource-period usage among max-revenue allocations
	Cert    Certificate // dependency certificate for Alloc
	Bounds  BoundEvidence
}

// Solve finds a feasible allocation maximizing revenue, breaking ties toward
// smaller total resource usage. It returns ErrInfeasible when no feasible
// allocation exists (e.g. the locked contracts already violate a constraint).
func Solve(inst *Instance) (*Result, error) {
	if err := inst.Validate(); err != nil {
		return nil, err
	}
	order, err := inst.topoOrder()
	if err != nil {
		return nil, err
	}
	s := newSearch(inst, order)
	s.run(nil)
	if !s.found {
		return nil, ErrInfeasible
	}
	alloc := Allocation{Starts: s.best}
	cert, err := BuildCertificate(inst, alloc)
	if err != nil {
		return nil, err
	}
	return &Result{
		Alloc:   alloc,
		Revenue: s.bestRev,
		Usage:   s.bestUsage,
		Cert:    cert,
		Bounds: BoundEvidence{
			RevenueLower: s.bestRev,
			RevenueUpper: inst.relaxationBound(),
		},
	}, nil
}

// relaxationBound is a valid upper bound on the revenue of any feasible
// allocation: locked revenue plus the highest positive revenues of the
// remaining contracts, respecting the MaxContracts selection limit.
func (inst *Instance) relaxationBound() int64 {
	lockedCount := 0
	var lockedRev int64
	var pos []int64
	for i := range inst.Contracts {
		c := &inst.Contracts[i]
		if c.Locked {
			lockedCount++
			lockedRev += c.Revenue
			continue
		}
		if c.Revenue > 0 {
			pos = append(pos, c.Revenue)
		}
	}
	sort.Slice(pos, func(a, b int) bool { return pos[a] > pos[b] })
	slots := MaxContracts - lockedCount
	sum := lockedRev
	for i := 0; i < len(pos) && i < slots; i++ {
		sum += pos[i]
	}
	return sum
}

// search is a branch-and-bound over contracts in topological order. When old
// is non-nil the objective becomes lexicographic: minimize the number of
// contracts whose allocation differs from old, then maximize revenue, then
// minimize total usage.
type search struct {
	inst   *Instance
	order  []int
	idx    map[string]int
	used   [][]int64 // remaining-usage tracker: used[period][resource]
	cur    map[string]int
	groups map[string]bool
	count  int
	rev    int64
	usage  int64

	old *Allocation // previous allocation for revision search; nil for plain solve
	ch  int         // changes versus old accumulated so far

	found     bool
	bestRev   int64
	bestUsage int64
	bestCh    int
	best      map[string]int

	suffixPos [][]int64 // suffixPos[k]: positive revenues of order[k:], sorted descending
}

func newSearch(inst *Instance, order []int) *search {
	s := &search{
		inst:   inst,
		order:  order,
		idx:    inst.index(),
		used:   make([][]int64, inst.NumPeriods()),
		cur:    map[string]int{},
		groups: map[string]bool{},
	}
	for p := range s.used {
		s.used[p] = make([]int64, inst.NumResources())
	}
	n := len(order)
	s.suffixPos = make([][]int64, n+1)
	for k := n - 1; k >= 0; k-- {
		rev := inst.Contracts[order[k]].Revenue
		l := append([]int64(nil), s.suffixPos[k+1]...)
		if rev > 0 {
			l = append(l, rev)
			sort.Slice(l, func(a, b int) bool { return l[a] > l[b] })
		}
		s.suffixPos[k] = l
	}
	return s
}

func (s *search) run(old *Allocation) {
	s.old = old
	s.dfs(0)
}

// suffixBound sums the up-to-slots highest positive revenues of the
// undecided suffix; current revenue plus this bounds anything reachable.
func (s *search) suffixBound(k, slots int) int64 {
	l := s.suffixPos[k]
	if slots > len(l) {
		slots = len(l)
	}
	var sum int64
	for i := 0; i < slots; i++ {
		sum += l[i]
	}
	return sum
}

func (s *search) pruned(k int) bool {
	if !s.found {
		return false
	}
	if s.old != nil {
		if s.ch > s.bestCh {
			return true
		}
		if s.ch < s.bestCh {
			return false // fewer changes so far: revenue bound does not apply
		}
	}
	return s.rev+s.suffixBound(k, MaxContracts-s.count) < s.bestRev
}

// better reports whether the current leaf improves on the incumbent under
// the lexicographic objective.
func (s *search) better() bool {
	if !s.found {
		return true
	}
	if s.old != nil && s.ch != s.bestCh {
		return s.ch < s.bestCh
	}
	if s.rev != s.bestRev {
		return s.rev > s.bestRev
	}
	return s.usage < s.bestUsage
}

func (s *search) dfs(k int) {
	if s.pruned(k) {
		return
	}
	if k == len(s.order) {
		if s.better() {
			s.found = true
			s.bestRev, s.bestUsage, s.bestCh = s.rev, s.usage, s.ch
			s.best = make(map[string]int, len(s.cur))
			for id, st := range s.cur {
				s.best[id] = st
			}
		}
		return
	}
	c := &s.inst.Contracts[s.order[k]]
	starts := c.Starts
	if c.Locked {
		starts = []int{c.LockedStart}
	}
	if s.count < MaxContracts && (c.Group == "" || !s.groups[c.Group]) {
		for _, st := range starts {
			if !s.prereqsOK(c, st) || !s.fits(c, st) {
				continue
			}
			s.place(c, st)
			s.dfs(k + 1)
			s.unplace(c, st)
		}
	}
	if c.Locked {
		return // locked contracts must be placed; no skip branch
	}
	if s.old != nil {
		if _, was := s.old.Starts[c.ID]; was {
			s.ch++
			s.dfs(k + 1)
			s.ch--
			return
		}
	}
	s.dfs(k + 1)
}

func (s *search) prereqsOK(c *Contract, st int) bool {
	for _, pre := range c.Prereqs {
		pst, ok := s.cur[pre]
		if !ok {
			return false
		}
		if pst+s.inst.Contracts[s.idx[pre]].Duration > st {
			return false
		}
	}
	return true
}

func (s *search) fits(c *Contract, st int) bool {
	for p := st; p < st+c.Duration; p++ {
		for r, u := range c.Usage {
			if s.used[p][r]+u > s.inst.Capacity[p][r] {
				return false
			}
		}
	}
	return true
}

func (s *search) place(c *Contract, st int) {
	for p := st; p < st+c.Duration; p++ {
		for r, u := range c.Usage {
			s.used[p][r] += u
		}
	}
	s.cur[c.ID] = st
	if c.Group != "" {
		s.groups[c.Group] = true
	}
	s.count++
	s.rev += c.Revenue
	var per int64
	for _, u := range c.Usage {
		per += u
	}
	s.usage += per * int64(c.Duration)
	if s.old != nil {
		if ost, was := s.old.Starts[c.ID]; !was || ost != st {
			s.ch++
		}
	}
}

func (s *search) unplace(c *Contract, st int) {
	if s.old != nil {
		if ost, was := s.old.Starts[c.ID]; !was || ost != st {
			s.ch--
		}
	}
	var per int64
	for _, u := range c.Usage {
		per += u
	}
	s.usage -= per * int64(c.Duration)
	s.rev -= c.Revenue
	s.count--
	if c.Group != "" {
		delete(s.groups, c.Group)
	}
	delete(s.cur, c.ID)
	for p := st; p < st+c.Duration; p++ {
		for r, u := range c.Usage {
			s.used[p][r] -= u
		}
	}
}
