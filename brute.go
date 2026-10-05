package contractopt

// This file contains exhaustive enumerators used to cross-check the
// branch-and-bound solver on small instances: every subset of contracts and
// every candidate start assignment is enumerated and checked for
// feasibility, so the optimum found here is exact by construction.

// BruteForce enumerates all subsets and start assignments and returns the
// same optimum as Solve. It is exponential and intended for small instances.
func BruteForce(inst *Instance) (*Result, error) {
	if err := inst.Validate(); err != nil {
		return nil, err
	}
	b := &brute{inst: inst, cur: Allocation{Starts: map[string]int{}}}
	b.enumerate(0, nil)
	if !b.found {
		return nil, ErrInfeasible
	}
	cert, err := BuildCertificate(inst, b.best)
	if err != nil {
		return nil, err
	}
	return &Result{
		Alloc:   b.best,
		Revenue: b.bestRev,
		Usage:   b.bestUsage,
		Cert:    cert,
		Bounds: BoundEvidence{
			RevenueLower: b.bestRev,
			RevenueUpper: inst.relaxationBound(),
		},
	}, nil
}

// BruteForceRevise enumerates all subsets and start assignments and returns
// the same optimum as Revise. It is exponential and intended for small
// instances.
func BruteForceRevise(inst *Instance, old Allocation) (*RevisionResult, error) {
	if err := inst.Validate(); err != nil {
		return nil, err
	}
	b := &brute{inst: inst, cur: Allocation{Starts: map[string]int{}}}
	b.enumerate(0, &old)
	if !b.found {
		return nil, ErrInfeasible
	}
	cert, err := BuildCertificate(inst, b.best)
	if err != nil {
		return nil, err
	}
	changesLower := 1
	if inst.Check(old) == nil {
		changesLower = 0
	}
	return &RevisionResult{
		Old:     old,
		New:     b.best,
		Changes: b.bestCh,
		Revenue: b.bestRev,
		Usage:   b.bestUsage,
		Cert:    cert,
		Evidence: RevisionEvidence{
			ChangesLower: changesLower,
			ChangesUpper: b.bestCh,
			RevenueLower: b.bestRev,
			RevenueUpper: inst.relaxationBound(),
		},
	}, nil
}

type brute struct {
	inst *Instance
	cur  Allocation

	found     bool
	bestRev   int64
	bestUsage int64
	bestCh    int
	best      Allocation
}

func (b *brute) enumerate(i int, old *Allocation) {
	if i == len(b.inst.Contracts) {
		if err := b.inst.Check(b.cur); err != nil {
			return
		}
		rev := b.inst.Revenue(b.cur)
		usage := b.inst.TotalUsage(b.cur)
		ch := 0
		if old != nil {
			ch = countChanges(b.inst, *old, b.cur)
		}
		var better bool
		switch {
		case !b.found:
			better = true
		case old != nil && ch != b.bestCh:
			better = ch < b.bestCh
		case rev != b.bestRev:
			better = rev > b.bestRev
		default:
			better = usage < b.bestUsage
		}
		if better {
			b.found = true
			b.bestRev, b.bestUsage, b.bestCh = rev, usage, ch
			starts := make(map[string]int, len(b.cur.Starts))
			for id, st := range b.cur.Starts {
				starts[id] = st
			}
			b.best = Allocation{Starts: starts}
		}
		return
	}
	c := &b.inst.Contracts[i]
	starts := c.Starts
	if c.Locked {
		starts = []int{c.LockedStart}
	}
	for _, st := range starts {
		b.cur.Starts[c.ID] = st
		b.enumerate(i+1, old)
		delete(b.cur.Starts, c.ID)
	}
	if !c.Locked {
		b.enumerate(i+1, old) // skip contract i
	}
}
