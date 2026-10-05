package contractopt

import "fmt"

// PrereqProof is evidence that one prerequisite of a selected contract is
// satisfied: the prerequisite is selected and finishes (PrereqEnd) no later
// than the dependent contract starts (Required).
type PrereqProof struct {
	PrereqID  string
	PrereqEnd int // end period (start + duration) of the prerequisite
	Required  int // start period of the dependent contract; proof: PrereqEnd <= Required
}

// ContractProof records the scheduled span of one selected contract and the
// proof for each of its prerequisites.
type ContractProof struct {
	ID      string
	Start   int
	End     int // Start + Duration
	Prereqs []PrereqProof
}

// Certificate is a dependency certificate for an allocation: for every
// selected contract it lists the scheduled span and one proof per
// prerequisite. Verify recomputes every entry against the instance, so a
// certificate cannot attest anything the allocation does not satisfy.
type Certificate struct {
	Contracts []ContractProof // sorted by contract ID
}

// BuildCertificate checks the allocation for feasibility and then emits the
// dependency certificate for it.
func BuildCertificate(inst *Instance, alloc Allocation) (Certificate, error) {
	if err := inst.Check(alloc); err != nil {
		return Certificate{}, fmt.Errorf("contractopt: cannot certify infeasible allocation: %w", err)
	}
	idx := inst.index()
	cert := Certificate{Contracts: make([]ContractProof, 0, len(alloc.Starts))}
	for _, id := range alloc.Sorted() {
		c := inst.Contracts[idx[id]]
		st := alloc.Starts[id]
		cp := ContractProof{ID: id, Start: st, End: st + c.Duration}
		for _, pre := range c.Prereqs {
			cp.Prereqs = append(cp.Prereqs, PrereqProof{
				PrereqID:  pre,
				PrereqEnd: alloc.Starts[pre] + inst.Contracts[idx[pre]].Duration,
				Required:  st,
			})
		}
		cert.Contracts = append(cert.Contracts, cp)
	}
	return cert, nil
}

// Verify recomputes every proof entry against the instance and re-checks the
// allocation for full feasibility (selection limit, locked placement,
// candidate starts, mutual exclusion, per-period capacities, prerequisites).
func (c Certificate) Verify(inst *Instance, alloc Allocation) error {
	if err := inst.Check(alloc); err != nil {
		return fmt.Errorf("contractopt: allocation infeasible: %w", err)
	}
	if len(c.Contracts) != len(alloc.Starts) {
		return fmt.Errorf("contractopt: certificate covers %d contracts, allocation selects %d", len(c.Contracts), len(alloc.Starts))
	}
	idx := inst.index()
	seen := map[string]bool{}
	for _, cp := range c.Contracts {
		i, ok := idx[cp.ID]
		if !ok {
			return fmt.Errorf("contractopt: certificate names unknown contract %q", cp.ID)
		}
		if seen[cp.ID] {
			return fmt.Errorf("contractopt: certificate lists contract %q twice", cp.ID)
		}
		seen[cp.ID] = true
		st, ok := alloc.Starts[cp.ID]
		if !ok {
			return fmt.Errorf("contractopt: certificate covers unselected contract %q", cp.ID)
		}
		contract := inst.Contracts[i]
		if cp.Start != st || cp.End != st+contract.Duration {
			return fmt.Errorf("contractopt: certificate span [%d,%d) for %q does not match allocation", cp.Start, cp.End, cp.ID)
		}
		if len(cp.Prereqs) != len(contract.Prereqs) {
			return fmt.Errorf("contractopt: certificate has %d prerequisite proofs for %q, want %d", len(cp.Prereqs), cp.ID, len(contract.Prereqs))
		}
		for _, pp := range cp.Prereqs {
			pi, ok := idx[pp.PrereqID]
			if !ok {
				return fmt.Errorf("contractopt: certificate names unknown prerequisite %q", pp.PrereqID)
			}
			pst, ok := alloc.Starts[pp.PrereqID]
			if !ok {
				return fmt.Errorf("contractopt: prerequisite %q of %q not selected", pp.PrereqID, cp.ID)
			}
			end := pst + inst.Contracts[pi].Duration
			if pp.PrereqEnd != end || pp.Required != st {
				return fmt.Errorf("contractopt: stale prerequisite proof for %q -> %q", pp.PrereqID, cp.ID)
			}
			if end > st {
				return fmt.Errorf("contractopt: prerequisite %q ends at %d, after %q starts at %d", pp.PrereqID, end, cp.ID, st)
			}
		}
	}
	for id := range alloc.Starts {
		if !seen[id] {
			return fmt.Errorf("contractopt: certificate missing selected contract %q", id)
		}
	}
	return nil
}
