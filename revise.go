package contractopt

import "fmt"

// RevisionEvidence is the bound evidence for a revision. ChangesLower is a
// certified lower bound on the number of changed contracts (0 when the old
// allocation is still feasible in the revised instance, else 1);
// ChangesUpper is the achieved, provably minimal number of changes.
// RevenueLower is the achieved revenue; RevenueUpper is the relaxation
// bound valid for every feasible allocation of the revised instance.
type RevisionEvidence struct {
	ChangesLower int
	ChangesUpper int
	RevenueLower int64
	RevenueUpper int64
}

// RevisionResult is the outcome of Revise: the old and new allocations, the
// minimal number of changed contracts, the maximal revenue under that
// minimum, a dependency certificate for the new allocation, and bound
// evidence.
type RevisionResult struct {
	Old      Allocation
	New      Allocation
	Changes  int // minimized number of contracts whose selection or start changed
	Revenue  int64
	Usage    int64
	Cert     Certificate
	Evidence RevisionEvidence
}

// countChanges counts contracts whose selection status or start period
// differs between two allocations over the contracts of inst.
func countChanges(inst *Instance, old, new Allocation) int {
	changes := 0
	for i := range inst.Contracts {
		id := inst.Contracts[i].ID
		oldStart, oldSel := old.Starts[id]
		newStart, newSel := new.Starts[id]
		if oldSel != newSel || (oldSel && oldStart != newStart) {
			changes++
		}
	}
	return changes
}

// Revise re-optimizes after a contract revision. Given the revised instance
// and the allocation that was optimal before the revision, it finds a
// feasible allocation of the revised instance that first minimizes the
// number of changed contracts (selection status or start period versus old),
// then maximizes revenue, then minimizes total resource usage. Locked
// contracts remain fixed at their locked starts.
func Revise(inst *Instance, old Allocation) (*RevisionResult, error) {
	if err := inst.Validate(); err != nil {
		return nil, err
	}
	idx := inst.index()
	for id := range old.Starts {
		if _, ok := idx[id]; !ok {
			return nil, fmt.Errorf("contractopt: old allocation selects unknown contract %q", id)
		}
	}
	order, err := inst.topoOrder()
	if err != nil {
		return nil, err
	}
	s := newSearch(inst, order)
	s.run(&old)
	if !s.found {
		return nil, ErrInfeasible
	}
	alloc := Allocation{Starts: s.best}
	cert, err := BuildCertificate(inst, alloc)
	if err != nil {
		return nil, err
	}
	changesLower := 1
	if inst.Check(old) == nil {
		changesLower = 0
	}
	return &RevisionResult{
		Old:     old,
		New:     alloc,
		Changes: s.bestCh,
		Revenue: s.bestRev,
		Usage:   s.bestUsage,
		Cert:    cert,
		Evidence: RevisionEvidence{
			ChangesLower: changesLower,
			ChangesUpper: s.bestCh,
			RevenueLower: s.bestRev,
			RevenueUpper: inst.relaxationBound(),
		},
	}, nil
}
