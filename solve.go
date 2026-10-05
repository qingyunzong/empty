package placement

import "sort"

// Solve finds a minimum-cost feasible placement for p. If none exists,
// or p is malformed, the old placement is kept.
func Solve(p Problem) Result {
	old := append([]int(nil), p.OldPlacement...)
	if err := p.Validate(); err != nil {
		cert, valid := p.Verify(old)
		return Result{
			Placement: old, Cost: cert.TotalCost, KeptOld: true,
			Certificate: cert, CertificateValid: valid,
			Reason: "invalid problem: " + err.Error(),
		}
	}
	s := newSolver(p)
	s.search(0, 0)
	if !s.found {
		cert, valid := p.Verify(old)
		return Result{
			Placement: old, Cost: cert.TotalCost, KeptOld: true,
			Certificate: cert, CertificateValid: valid,
			Reason: "no feasible placement",
		}
	}
	cert, valid := p.Verify(s.best)
	return Result{
		Placement: append([]int(nil), s.best...), Cost: s.bestCost, Optimal: true,
		Certificate: cert, CertificateValid: valid,
	}
}

// solver is a branch-and-bound search over task-to-machine assignments.
type solver struct {
	p        Problem
	n, m     int
	allowed  [][]bool
	conflict []uint64
	order    []int   // task visit order
	try      [][]int // per-task machine preference order
	suffixLB []int   // suffix sums of forced-migration lower bounds
	assign   []int
	cpuUsed  []int
	memUsed  []int
	mTasks   []uint64
	used     []bool
	best     []int
	bestCost int
	found    bool
}

func countTrue(bs []bool) int {
	c := 0
	for _, b := range bs {
		if b {
			c++
		}
	}
	return c
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func newSolver(p Problem) *solver {
	n, m := len(p.Tasks), len(p.Machines)
	s := &solver{p: p, n: n, m: m, bestCost: int(^uint(0) >> 1)}
	s.allowed = make([][]bool, n)
	for i, t := range p.Tasks {
		row := make([]bool, m)
		for x := 0; x < m; x++ {
			row[x] = t.Allowed == nil || t.Allowed[x]
		}
		s.allowed[i] = row
	}
	s.conflict = make([]uint64, n)
	for _, c := range p.Conflicts {
		s.conflict[c[0]] |= 1 << uint(c[1])
		s.conflict[c[1]] |= 1 << uint(c[0])
	}
	// Visit constrained and large tasks first.
	s.order = make([]int, n)
	for i := range s.order {
		s.order[i] = i
	}
	sort.SliceStable(s.order, func(a, b int) bool {
		ia, ib := s.order[a], s.order[b]
		if ca, cb := countTrue(s.allowed[ia]), countTrue(s.allowed[ib]); ca != cb {
			return ca < cb
		}
		da := p.Tasks[ia].CPU + p.Tasks[ia].Mem
		db := p.Tasks[ib].CPU + p.Tasks[ib].Mem
		return da > db
	})
	// Try the old machine first, then running machines, then off ones:
	// cheap placements are found early, which tightens the bound.
	s.try = make([][]int, n)
	for i := 0; i < n; i++ {
		xs := make([]int, 0, m)
		for x := 0; x < m; x++ {
			if s.allowed[i][x] {
				xs = append(xs, x)
			}
		}
		old := p.OldPlacement[i]
		rank := func(x int) int {
			switch {
			case x == old:
				return 0
			case p.Machines[x].Running:
				return 1
			default:
				return 2
			}
		}
		sort.SliceStable(xs, func(a, b int) bool { return rank(xs[a]) < rank(xs[b]) })
		s.try[i] = xs
	}
	// Lower bound: a task whose old machine is disallowed must migrate.
	stay := make([]int, n)
	for i := 0; i < n; i++ {
		if old := p.OldPlacement[i]; old >= 0 && !s.allowed[i][old] {
			stay[i] = p.MigrationCost
		}
	}
	s.suffixLB = make([]int, n+1)
	for k := n - 1; k >= 0; k-- {
		s.suffixLB[k] = s.suffixLB[k+1] + stay[s.order[k]]
	}
	s.assign = make([]int, n)
	s.cpuUsed = make([]int, m)
	s.memUsed = make([]int, m)
	s.mTasks = make([]uint64, m)
	s.used = make([]bool, m)
	s.best = make([]int, n)
	// A feasible old placement is an initial incumbent and upper bound.
	if cert, ok := p.Verify(p.OldPlacement); ok {
		s.bestCost = cert.TotalCost
		copy(s.best, p.OldPlacement)
		s.found = true
	}
	return s
}

func (s *solver) search(k, cost int) {
	if cost+s.suffixLB[k] >= s.bestCost {
		return
	}
	if k == s.n {
		s.bestCost = cost
		copy(s.best, s.assign)
		s.found = true
		return
	}
	t := s.order[k]
	task := s.p.Tasks[t]
	old := s.p.OldPlacement[t]
	seenEmpty := make(map[[4]int]bool)
	for _, x := range s.try[t] {
		mc := s.p.Machines[x]
		if s.cpuUsed[x]+task.CPU > mc.CPUCap || s.memUsed[x]+task.Mem > mc.MemCap {
			continue
		}
		if s.mTasks[x]&s.conflict[t] != 0 {
			continue
		}
		if !s.used[x] {
			// Symmetry breaking: identical empty machines are equivalent.
			key := [4]int{mc.CPUCap, mc.MemCap, mc.StartupCost, boolInt(mc.Running)}
			if seenEmpty[key] {
				continue
			}
			seenEmpty[key] = true
		}
		delta := 0
		if !s.used[x] && !mc.Running {
			delta += mc.StartupCost
		}
		if old >= 0 && old != x {
			delta += s.p.MigrationCost
		}
		bit := uint64(1) << uint(t)
		s.assign[t] = x
		s.cpuUsed[x] += task.CPU
		s.memUsed[x] += task.Mem
		s.mTasks[x] |= bit
		wasUsed := s.used[x]
		s.used[x] = true
		s.search(k+1, cost+delta)
		s.used[x] = wasUsed
		s.mTasks[x] &^= bit
		s.cpuUsed[x] -= task.CPU
		s.memUsed[x] -= task.Mem
	}
}
