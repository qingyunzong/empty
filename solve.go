package contractopt

import "errors"

// ErrInfeasible is returned when no feasible assignment exists (this can only
// happen when locked contracts cannot be placed consistently).
var ErrInfeasible = errors.New("contractopt: no feasible assignment")

// Result couples an optimal solution with its dependency certificate.
type Result struct {
	Solution    Solution
	Certificate Certificate
}

// Solve finds an assignment that maximizes total revenue, breaking ties by
// smaller total resource usage, and proves optimality with a certificate.
func Solve(in *Instance) (Result, error) {
	if err := in.Validate(); err != nil {
		return Result{}, err
	}
	s := newSearch(in)
	s.run()
	if !s.hasBest {
		return Result{}, ErrInfeasible
	}
	sol := Solution{Assign: s.best, Revenue: s.bestRev, Usage: s.bestUsage}
	return Result{Solution: sol, Certificate: *buildCertificate(in, sol, s.nodes)}, nil
}

// search is a depth-first branch and bound over contracts in input order.
type search struct {
	in    *Instance
	idx   map[string]int
	n     int
	used  [][]int64
	sel   []int  // sel[i] = chosen start, -1 = not selected
	dec   []bool // decided
	group map[string]bool
	count int
	rev   int64
	usage int64

	suffix []int64 // suffix[i] = sum of positive revenues of contracts i..n-1

	best      map[string]int
	bestRev   int64
	bestUsage int64
	hasBest   bool
	nodes     int
}

func newSearch(in *Instance) *search {
	n := len(in.Contracts)
	s := &search{
		in:    in,
		idx:   in.index(),
		n:     n,
		sel:   make([]int, n),
		dec:   make([]bool, n),
		group: make(map[string]bool),
		nodes: 0,
	}
	for i := range s.sel {
		s.sel[i] = -1
	}
	s.used = make([][]int64, in.Periods)
	for p := range s.used {
		s.used[p] = make([]int64, in.Resources)
	}
	for i := range s.sel {
		s.sel[i] = -1
	}
	s.suffix = make([]int64, n+1)
	for i := n - 1; i >= 0; i-- {
		s.suffix[i] = s.suffix[i+1]
		if r := in.Contracts[i].Revenue; r > 0 {
			s.suffix[i] += r
		}
	}
	return s
}

func (s *search) run() {
	s.dfs(0)
}

// boundTight reports whether the partial state can still improve on best.
func (s *search) boundTight(i int) bool {
	if !s.hasBest {
		return false
	}
	ub := s.rev + s.suffix[i]
	if ub < s.bestRev {
		return true
	}
	// Revenue can at most tie; usage only grows, so no improvement is possible.
	return ub == s.bestRev && s.usage >= s.bestUsage
}

func (s *search) dfs(i int) {
	if s.boundTight(i) {
		return
	}
	s.nodes++
	if i == s.n {
		s.commit()
		return
	}
	c := &s.in.Contracts[i]
	if c.Locked {
		// Locked contracts have exactly one option.
		if s.canPlace(i, c.Start) {
			s.place(i, c.Start)
			s.dfs(i + 1)
			s.unplace(i, c.Start)
		}
		return
	}
	// Option 1: skip the contract.
	s.dec[i] = true
	s.dfs(i + 1)
	s.dec[i] = false
	// Option 2: select it at each feasible candidate start.
	for _, st := range c.Starts {
		if !s.canPlace(i, st) {
			continue
		}
		s.place(i, st)
		s.dfs(i + 1)
		s.unplace(i, st)
	}
}

// canPlace checks capacity, count, mutex and already-decided prereqs.
func (s *search) canPlace(i int, st int) bool {
	c := &s.in.Contracts[i]
	if s.count+1 > s.in.MaxSelect {
		return false
	}
	if c.Group != "" && s.group[c.Group] {
		return false
	}
	for _, qid := range c.Prereqs {
		j := s.idx[qid]
		if s.dec[j] {
			if s.sel[j] < 0 {
				return false // prereq already skipped
			}
			if s.sel[j]+s.in.Contracts[j].Duration > st {
				return false // prereq finishes too late for this start
			}
		}
	}
	for p := st; p < st+c.Duration; p++ {
		for r := 0; r < s.in.Resources; r++ {
			if s.used[p][r]+c.Demand[r] > s.in.Capacity[p][r] {
				return false
			}
		}
	}
	return true
}

func (s *search) place(i int, st int) {
	c := &s.in.Contracts[i]
	s.dec[i] = true
	s.sel[i] = st
	s.count++
	s.rev += c.Revenue
	s.usage += contractUsage(c)
	if c.Group != "" {
		s.group[c.Group] = true
	}
	for p := st; p < st+c.Duration; p++ {
		for r := 0; r < s.in.Resources; r++ {
			s.used[p][r] += c.Demand[r]
		}
	}
}

func (s *search) unplace(i int, st int) {
	c := &s.in.Contracts[i]
	s.dec[i] = false
	s.sel[i] = -1
	s.count--
	s.rev -= c.Revenue
	s.usage -= contractUsage(c)
	if c.Group != "" {
		s.group[c.Group] = false
	}
	for p := st; p < st+c.Duration; p++ {
		for r := 0; r < s.in.Resources; r++ {
			s.used[p][r] -= c.Demand[r]
		}
	}
}

// commit validates deferred prereq edges and records a new incumbent.
func (s *search) commit() {
	for i := 0; i < s.n; i++ {
		if s.sel[i] < 0 {
			continue
		}
		for _, qid := range s.in.Contracts[i].Prereqs {
			j := s.idx[qid]
			if s.sel[j] < 0 || s.sel[j]+s.in.Contracts[j].Duration > s.sel[i] {
				return
			}
		}
	}
	if !s.hasBest || better(s.rev, s.usage, s.bestRev, s.bestUsage) {
		s.hasBest = true
		s.bestRev = s.rev
		s.bestUsage = s.usage
		s.best = make(map[string]int, s.count)
		for i := 0; i < s.n; i++ {
			if s.sel[i] >= 0 {
				s.best[s.in.Contracts[i].ID] = s.sel[i]
			}
		}
	}
}
