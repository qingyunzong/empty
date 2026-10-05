package solver

// Stats records search effort and the proven bound.
type Stats struct {
	Nodes      int `json:"nodes"`
	Pruned     int `json:"pruned"`
	BoundCost  int `json:"boundCost"`  // proven lower bound on cost
	BoundCount int `json:"boundCount"` // proven lower bound on test count at BoundCost
}

// Result is the outcome of Solve.
type Result struct {
	Status   Status
	Selected []int // test indices (input order), nil when infeasible
	Cost     int
	Count    int
	Time     int
	Stats    Stats
}

// Options tunes the search.
type Options struct {
	// MaxNodes caps branch-and-bound nodes; 0 means unlimited. When the cap
	// is hit the best incumbent is returned with Status == Feasible.
	MaxNodes int
}

// Solve finds a lexicographically (cost, count) minimal selection of tests
// that covers all required branches and pairs, is closed under
// prerequisites, and respects the time limit.
func Solve(inst *Instance, opts *Options) (*Result, error) {
	c, err := compile(inst)
	if err != nil {
		return nil, err
	}
	s := &search{c: c}
	if opts != nil {
		s.maxNodes = opts.MaxNodes
	}
	s.bestCost = -1
	s.bestCount = 0

	// Seed the incumbent with a greedy cover so bounding starts immediately.
	if g, ok := s.greedy(); ok {
		s.setBest(g)
	}

	// The root lower bound is a proven bound on the optimal objective,
	// reported in the certificate as the search bound.
	rootCost, rootCount, _, _ := s.lowerBound(
		newBitset(len(inst.Branches)), newBitset(len(inst.Pairs)), 0, 0)
	s.boundCost, s.boundCount = rootCost, rootCount
	s.expand(0, 0, 0, newBitset(len(inst.Branches)), newBitset(len(inst.Pairs)), 0, 0, 0)

	res := &Result{Stats: Stats{
		Nodes:      s.nodes,
		Pruned:     s.pruned,
		BoundCost:  s.boundCost,
		BoundCount: s.boundCount,
	}}
	switch {
	case s.bestCost < 0 && s.cutoff:
		res.Status = Unknown
	case s.bestCost < 0:
		res.Status = Infeasible
		// The bound is meaningless without an incumbent; report the
		// strongest statement we proved: no feasible solution exists.
		res.Stats.BoundCost = 0
		res.Stats.BoundCount = 0
	case s.cutoff:
		res.Status = Feasible
		s.applyBest(res)
	default:
		res.Status = Optimal
		s.applyBest(res)
		// Proven optimal: the bound matches the incumbent.
		res.Stats.BoundCost = res.Cost
		res.Stats.BoundCount = res.Count
	}
	return res, nil
}

func (s *search) applyBest(res *Result) {
	res.Cost = s.bestCost
	res.Count = s.bestCount
	res.Time = s.bestTime
	res.Selected = res.Selected[:0]
	m := s.bestMask
	for i := 0; i < s.c.n; i++ {
		if m&(1<<uint(i)) != 0 {
			res.Selected = append(res.Selected, i)
		}
	}
}

type search struct {
	c        *compiled
	maxNodes int

	nodes  int
	pruned int
	cutoff bool

	bestCost  int
	bestCount int
	bestTime  int
	bestMask  uint64

	boundCost  int
	boundCount int
}

// greedy builds a feasible cover by repeatedly adding the test whose
// closure covers the most still-uncovered requirements per unit of marginal
// cost. It returns the selected test mask.
func (s *search) greedy() (uint64, bool) {
	c := s.c
	var sel uint64
	cost, time := 0, 0
	covB := newBitset(len(c.inst.Branches))
	covP := newBitset(len(c.inst.Pairs))
	total := len(c.inst.Branches) + len(c.inst.Pairs)
	uncovered := total
	for uncovered > 0 {
		best, bestScore, bestMarg := -1, -1, 0
		for i := 0; i < c.n; i++ {
			if sel&(1<<uint(i)) != 0 {
				continue
			}
			add := c.closure[i] &^ sel
			mCost, mTime := 0, 0
			for m := add; m != 0; m &= m - 1 {
				j := bitsTrailing(m)
				mCost += c.costs[j]
				mTime += c.times[j]
			}
			if time+mTime > c.inst.TimeLimit {
				continue
			}
			gain := 0
			for m := add; m != 0; m &= m - 1 {
				j := bitsTrailing(m)
				gain += covB.missingFrom(c.coverB[j]) + covP.missingFrom(c.coverP[j])
			}
			if gain == 0 {
				continue
			}
			// Higher gain* (marg+1) relative... compare gain/(mCost+1).
			if best < 0 || gain*(bestMarg+1) > bestScore*(mCost+1) {
				best, bestScore, bestMarg = i, gain, mCost
			}
		}
		if best < 0 {
			return 0, false
		}
		add := c.closure[best] &^ sel
		for m := add; m != 0; m &= m - 1 {
			j := bitsTrailing(m)
			cost += c.costs[j]
			time += c.times[j]
			uncovered -= covB.missingFrom(c.coverB[j]) + covP.missingFrom(c.coverP[j])
			covB.unionInto(c.coverB[j])
			covP.unionInto(c.coverP[j])
		}
		sel |= add
	}
	_ = cost
	return sel, true
}

func (s *search) setBest(mask uint64) {
	c := s.c
	cost, count, time := 0, 0, 0
	for m := mask; m != 0; m &= m - 1 {
		j := bitsTrailing(m)
		cost += c.costs[j]
		time += c.times[j]
		count++
	}
	s.bestCost, s.bestCount, s.bestTime, s.bestMask = cost, count, time, mask
}

// better reports whether (cost, count) strictly improves the incumbent.
func (s *search) better(cost, count int) bool {
	if s.bestCost < 0 {
		return true
	}
	if cost != s.bestCost {
		return cost < s.bestCost
	}
	return count < s.bestCount
}

// lowerBound computes admissible lower bounds on the additional cost and
// the additional number of tests needed to cover the requirements still
// uncovered by (covB, covP), using only tests that are neither selected nor
// banned. timeLB is a lower bound on the additional time any cover needs:
// the max over uncovered requirements of the fastest available coverer.
//
// Cost bound: max over requirements r of the cheapest available coverer of
// r (each requirement must be covered individually), and also
// ceil(sum of cheapest coverer costs / K) where K is the maximum number of
// uncovered requirements any single available test can cover.
func (s *search) lowerBound(covB, covP bitset, sel, banned uint64) (costLB, countLB, timeLB int, infeasible bool) {
	c := s.c
	avail := ^(sel | banned) & ((uint64(1) << uint(c.n)) - 1)
	uncovered := 0
	sumMinCost := 0
	maxMinCost := 0
	maxMinTime := 0

	scan := func(coverers [][]int, req bitset, cov bitset) bool {
		for r := 0; r < len(coverers); r++ {
			if !req.has(r) || cov.has(r) {
				continue
			}
			uncovered++
			minCost, minTime := -1, -1
			for _, t := range coverers[r] {
				if avail&(1<<uint(t)) == 0 {
					continue
				}
				if minCost < 0 || c.costs[t] < minCost {
					minCost = c.costs[t]
				}
				if minTime < 0 || c.times[t] < minTime {
					minTime = c.times[t]
				}
			}
			if minCost < 0 {
				return false
			}
			sumMinCost += minCost
			if minCost > maxMinCost {
				maxMinCost = minCost
			}
			if minTime > maxMinTime {
				maxMinTime = minTime
			}
		}
		return true
	}
	if !scan(c.coverersB, c.reqB, covB) || !scan(c.coverersP, c.reqP, covP) {
		return 0, 0, 0, true
	}
	if uncovered == 0 {
		return 0, 0, 0, false
	}

	// K: max uncovered requirements coverable by one available test.
	k := 0
	for m := avail; m != 0; m &= m - 1 {
		t := bitsTrailing(m)
		cov := covB.missingFrom(c.coverB[t]) + covP.missingFrom(c.coverP[t])
		if cov > k {
			k = cov
		}
	}
	costLB = maxMinCost
	if k > 0 {
		if v := (sumMinCost + k - 1) / k; v > costLB {
			costLB = v
		}
		countLB = (uncovered + k - 1) / k
	} else {
		countLB = 1
	}
	if countLB < 1 {
		countLB = 1
	}
	return costLB, countLB, maxMinTime, false
}

// expand explores decisions for tests at positions pos..n-1 of the
// branching order. sel/banned are test bitmasks; covB/covP track coverage;
// cost, count, time accumulate the selection.
func (s *search) expand(pos int, sel, banned uint64, covB, covP bitset, cost, count, time int) {
	if s.cutoff {
		return
	}
	s.nodes++
	if s.maxNodes > 0 && s.nodes > s.maxNodes {
		s.cutoff = true
		return
	}
	c := s.c

	// Bounding: can the remaining requirements still be covered well enough?
	costLB, countLB, timeLB, infeas := s.lowerBound(covB, covP, sel, banned)
	if infeas || time+timeLB > c.inst.TimeLimit {
		s.pruned++
		return
	}
	if s.bestCost >= 0 {
		ec, en := cost+costLB, count+countLB
		if ec > s.bestCost || (ec == s.bestCost && en >= s.bestCount) {
			s.pruned++
			return
		}
	}

	if pos == c.n {
		if covB.contains(c.reqB) && covP.contains(c.reqP) && s.better(cost, count) {
			s.setBest(sel)
		}
		return
	}

	t := c.order[pos]
	bit := uint64(1) << uint(t)
	switch {
	case sel&bit != 0:
		// Already pulled in as a prerequisite; nothing to decide.
		s.expand(pos+1, sel, banned, covB, covP, cost, count, time)
	case banned&bit != 0:
		s.expand(pos+1, sel, banned, covB, covP, cost, count, time)
	default:
		// Include branch: only if the closure avoids banned tests and the
		// time limit is not exceeded.
		cl := c.closure[t]
		if cl&banned == 0 {
			add := cl &^ sel
			nCost, nCount, nTime := cost, count, time
			nb := newBitset(len(c.inst.Branches))
			nb.unionInto(covB)
			np := newBitset(len(c.inst.Pairs))
			np.unionInto(covP)
			for m := add; m != 0; m &= m - 1 {
				j := bitsTrailing(m)
				nCost += c.costs[j]
				nTime += c.times[j]
				nCount++
				nb.unionInto(c.coverB[j])
				np.unionInto(c.coverP[j])
			}
			if nTime <= c.inst.TimeLimit {
				s.expand(pos+1, sel|add, banned, nb, np, nCost, nCount, nTime)
			} else {
				s.pruned++
			}
		}
		// Exclude branch: forbid t entirely. Any later closure containing
		// t is then rejected, so each closed subset is generated once.
		s.expand(pos+1, sel, banned|bit, covB, covP, cost, count, time)
	}
}
