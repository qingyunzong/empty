// Package contractopt selects and schedules contracts to maximize revenue
// under per-period resource capacities, prerequisite and mutual-exclusion
// constraints, and re-optimizes after a contract revision with the fewest
// possible changes to a previous allocation.
//
// All data (capacities, usage, revenues, prerequisites, exclusion groups)
// is public input. Resource capacities are integer vectors, one per time
// period. At most MaxContracts contracts may be selected.
package contractopt

import (
	"errors"
	"fmt"
	"sort"
)

// MaxContracts bounds how many contracts may be selected, locked ones included.
const MaxContracts = 20

// ErrInfeasible reports that no feasible allocation exists, for example when
// the locked contracts already violate a constraint.
var ErrInfeasible = errors.New("contractopt: no feasible allocation")

// Contract describes one selectable contract.
type Contract struct {
	ID          string   // unique identifier
	Revenue     int64    // revenue earned when selected
	Usage       []int64  // resource usage per period while running; len == number of resources
	Duration    int      // number of consecutive periods the contract occupies
	Starts      []int    // candidate start periods; ignored when Locked
	Prereqs     []string // contracts that must be selected and finished before this one starts
	Group       string   // mutual-exclusion group: at most one selected per group; "" = none
	Locked      bool     // existing contract: must be selected exactly at LockedStart
	LockedStart int      // fixed start of an existing (locked) contract
}

// Instance is a contract-selection problem. Capacity[period] is the integer
// resource vector available in that period.
type Instance struct {
	Contracts []Contract
	Capacity  [][]int64 // Capacity[period][resource]
}

// NumPeriods returns the number of time periods.
func (inst *Instance) NumPeriods() int { return len(inst.Capacity) }

// NumResources returns the number of resource types.
func (inst *Instance) NumResources() int {
	if len(inst.Capacity) == 0 {
		return 0
	}
	return len(inst.Capacity[0])
}

// Allocation records the chosen start period for every selected contract.
type Allocation struct {
	Starts map[string]int // contract ID -> start period
}

// Selected reports whether the contract is part of the allocation.
func (a Allocation) Selected(id string) bool {
	_, ok := a.Starts[id]
	return ok
}

// Count returns the number of selected contracts.
func (a Allocation) Count() int { return len(a.Starts) }

// Sorted returns the selected contract IDs in deterministic order.
func (a Allocation) Sorted() []string {
	ids := make([]string, 0, len(a.Starts))
	for id := range a.Starts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (inst *Instance) index() map[string]int {
	m := make(map[string]int, len(inst.Contracts))
	for i := range inst.Contracts {
		m[inst.Contracts[i].ID] = i
	}
	return m
}

// Revenue sums the revenue of the selected contracts.
func (inst *Instance) Revenue(alloc Allocation) int64 {
	idx := inst.index()
	var total int64
	for id := range alloc.Starts {
		total += inst.Contracts[idx[id]].Revenue
	}
	return total
}

// TotalUsage sums resource-period usage over all selected contracts; it is
// the tie-break quantity minimized once revenue is maximal.
func (inst *Instance) TotalUsage(alloc Allocation) int64 {
	idx := inst.index()
	var total int64
	for id := range alloc.Starts {
		c := inst.Contracts[idx[id]]
		var per int64
		for _, u := range c.Usage {
			per += u
		}
		total += per * int64(c.Duration)
	}
	return total
}

// Validate checks the instance data itself for consistency.
func (inst *Instance) Validate() error {
	if len(inst.Capacity) == 0 {
		return errors.New("contractopt: instance has no periods")
	}
	nres := len(inst.Capacity[0])
	if nres == 0 {
		return errors.New("contractopt: instance has no resources")
	}
	for p, row := range inst.Capacity {
		if len(row) != nres {
			return fmt.Errorf("contractopt: capacity row %d has %d resources, want %d", p, len(row), nres)
		}
		for _, v := range row {
			if v < 0 {
				return errors.New("contractopt: negative capacity")
			}
		}
	}
	ids := map[string]bool{}
	for i := range inst.Contracts {
		c := &inst.Contracts[i]
		if c.ID == "" {
			return errors.New("contractopt: contract with empty ID")
		}
		if ids[c.ID] {
			return fmt.Errorf("contractopt: duplicate contract ID %q", c.ID)
		}
		ids[c.ID] = true
	}
	locked := 0
	for i := range inst.Contracts {
		c := &inst.Contracts[i]
		if c.Duration < 1 {
			return fmt.Errorf("contractopt: contract %q has duration %d", c.ID, c.Duration)
		}
		if len(c.Usage) != nres {
			return fmt.Errorf("contractopt: contract %q usage has %d resources, want %d", c.ID, len(c.Usage), nres)
		}
		for _, u := range c.Usage {
			if u < 0 {
				return fmt.Errorf("contractopt: contract %q has negative usage", c.ID)
			}
		}
		if c.Locked {
			locked++
			if c.LockedStart < 0 || c.LockedStart+c.Duration > inst.NumPeriods() {
				return fmt.Errorf("contractopt: locked contract %q start %d out of range", c.ID, c.LockedStart)
			}
		} else {
			if len(c.Starts) == 0 {
				return fmt.Errorf("contractopt: contract %q has no candidate starts", c.ID)
			}
			for _, s := range c.Starts {
				if s < 0 || s+c.Duration > inst.NumPeriods() {
					return fmt.Errorf("contractopt: contract %q start %d out of range", c.ID, s)
				}
			}
		}
		for _, pre := range c.Prereqs {
			if pre == c.ID {
				return fmt.Errorf("contractopt: contract %q requires itself", c.ID)
			}
			if !ids[pre] {
				return fmt.Errorf("contractopt: contract %q requires unknown contract %q", c.ID, pre)
			}
		}
	}
	if locked > MaxContracts {
		return fmt.Errorf("contractopt: %d locked contracts exceed the limit of %d", locked, MaxContracts)
	}
	_, err := inst.topoOrder()
	return err
}

// topoOrder returns contract indices with every prerequisite before its
// dependents, or an error if the prerequisite graph has a cycle.
func (inst *Instance) topoOrder() ([]int, error) {
	n := len(inst.Contracts)
	idx := inst.index()
	indeg := make([]int, n)
	adj := make([][]int, n)
	for j := range inst.Contracts {
		for _, pre := range inst.Contracts[j].Prereqs {
			i := idx[pre]
			adj[i] = append(adj[i], j)
			indeg[j]++
		}
	}
	var queue []int
	for i := 0; i < n; i++ {
		if indeg[i] == 0 {
			queue = append(queue, i)
		}
	}
	var order []int
	for len(queue) > 0 {
		i := queue[0]
		queue = queue[1:]
		order = append(order, i)
		for _, j := range adj[i] {
			indeg[j]--
			if indeg[j] == 0 {
				queue = append(queue, j)
			}
		}
	}
	if len(order) != n {
		return nil, errors.New("contractopt: prerequisite cycle detected")
	}
	return order, nil
}

// Check verifies full feasibility of an allocation against the instance:
// selection limit, locked placement, candidate starts, prerequisite
// selection and completion times, mutual exclusion, and per-period
// resource capacities.
func (inst *Instance) Check(alloc Allocation) error {
	idx := inst.index()
	for id := range alloc.Starts {
		if _, ok := idx[id]; !ok {
			return fmt.Errorf("contractopt: allocation selects unknown contract %q", id)
		}
	}
	if len(alloc.Starts) > MaxContracts {
		return fmt.Errorf("contractopt: %d contracts selected, limit is %d", len(alloc.Starts), MaxContracts)
	}
	groups := map[string]string{}
	used := make([][]int64, inst.NumPeriods())
	for p := range used {
		used[p] = make([]int64, inst.NumResources())
	}
	for i := range inst.Contracts {
		c := &inst.Contracts[i]
		st, sel := alloc.Starts[c.ID]
		if c.Locked {
			if !sel {
				return fmt.Errorf("contractopt: locked contract %q not selected", c.ID)
			}
			if st != c.LockedStart {
				return fmt.Errorf("contractopt: locked contract %q starts at %d, must be %d", c.ID, st, c.LockedStart)
			}
		}
		if !sel {
			continue
		}
		if !c.Locked {
			ok := false
			for _, s := range c.Starts {
				if s == st {
					ok = true
					break
				}
			}
			if !ok {
				return fmt.Errorf("contractopt: contract %q starts at %d, not a candidate start", c.ID, st)
			}
		}
		if c.Group != "" {
			if other, ok := groups[c.Group]; ok {
				return fmt.Errorf("contractopt: contracts %q and %q share exclusion group %q", other, c.ID, c.Group)
			}
			groups[c.Group] = c.ID
		}
		for _, pre := range c.Prereqs {
			pst, ok := alloc.Starts[pre]
			if !ok {
				return fmt.Errorf("contractopt: contract %q selected without prerequisite %q", c.ID, pre)
			}
			if end := pst + inst.Contracts[idx[pre]].Duration; end > st {
				return fmt.Errorf("contractopt: prerequisite %q ends at %d, after %q starts at %d", pre, end, c.ID, st)
			}
		}
		for p := st; p < st+c.Duration; p++ {
			for r, u := range c.Usage {
				used[p][r] += u
				if used[p][r] > inst.Capacity[p][r] {
					return fmt.Errorf("contractopt: resource %d over capacity in period %d (%d > %d)", r, p, used[p][r], inst.Capacity[p][r])
				}
			}
		}
	}
	return nil
}
