// Package contractopt selects a revenue-maximizing set of contracts subject
// to per-period integer resource capacities, prerequisite completion
// constraints, at-most-one mutex groups, locked pre-existing contracts and a
// selection-count limit of at most 20 contracts.
package contractopt

import "fmt"

// MaxSelectLimit is the hard upper bound on selectable contracts.
const MaxSelectLimit = 20

// Contract describes one selectable contract.
type Contract struct {
	ID       string   // unique identifier
	Revenue  int64    // revenue earned if selected
	Duration int      // number of consecutive periods occupied
	Demand   []int64  // per-resource demand while active (len == Resources)
	Starts   []int    // candidate start periods (ignored when Locked)
	Prereqs  []string // IDs that must be selected and finished before Start
	Group    string   // at-most-one mutex group; "" means no group
	Locked   bool     // pre-existing contract: must be selected at Start
	Start    int      // fixed start period, only meaningful when Locked
}

// Instance is a full problem instance.
type Instance struct {
	Periods   int
	Resources int
	Capacity  [][]int64 // Capacity[period][resource], integer vector per period
	Contracts []Contract
	MaxSelect int // selection limit, must be in [0, MaxSelectLimit]
}

// Solution is one feasible (or optimal) assignment.
type Solution struct {
	Assign  map[string]int // contract ID -> chosen start period
	Revenue int64          // total revenue
	Usage   int64          // total resource consumption over all periods/resources
}

// Validate checks the instance is well formed.
func (in *Instance) Validate() error {
	if in.Periods <= 0 {
		return fmt.Errorf("contractopt: Periods must be positive, got %d", in.Periods)
	}
	if in.Resources <= 0 {
		return fmt.Errorf("contractopt: Resources must be positive, got %d", in.Resources)
	}
	if len(in.Capacity) != in.Periods {
		return fmt.Errorf("contractopt: Capacity has %d periods, want %d", len(in.Capacity), in.Periods)
	}
	for p, row := range in.Capacity {
		if len(row) != in.Resources {
			return fmt.Errorf("contractopt: Capacity[%d] has %d resources, want %d", p, len(row), in.Resources)
		}
		for r, v := range row {
			if v < 0 {
				return fmt.Errorf("contractopt: Capacity[%d][%d] is negative", p, r)
			}
		}
	}
	if in.MaxSelect < 0 || in.MaxSelect > MaxSelectLimit {
		return fmt.Errorf("contractopt: MaxSelect %d outside [0, %d]", in.MaxSelect, MaxSelectLimit)
	}
	seen := make(map[string]bool, len(in.Contracts))
	for i := range in.Contracts {
		c := &in.Contracts[i]
		if c.ID == "" {
			return fmt.Errorf("contractopt: contract %d has empty ID", i)
		}
		if seen[c.ID] {
			return fmt.Errorf("contractopt: duplicate contract ID %q", c.ID)
		}
		seen[c.ID] = true
		if c.Duration <= 0 {
			return fmt.Errorf("contractopt: contract %q has non-positive duration", c.ID)
		}
		if len(c.Demand) != in.Resources {
			return fmt.Errorf("contractopt: contract %q demand length %d, want %d", c.ID, len(c.Demand), in.Resources)
		}
		for r, d := range c.Demand {
			if d < 0 {
				return fmt.Errorf("contractopt: contract %q demand[%d] is negative", c.ID, r)
			}
		}
		if c.Locked {
			if c.Start < 0 || c.Start+c.Duration > in.Periods {
				return fmt.Errorf("contractopt: locked contract %q start %d out of range", c.ID, c.Start)
			}
		} else {
			if len(c.Starts) == 0 {
				return fmt.Errorf("contractopt: contract %q has no candidate starts", c.ID)
			}
			for _, s := range c.Starts {
				if s < 0 || s+c.Duration > in.Periods {
					return fmt.Errorf("contractopt: contract %q start %d out of range", c.ID, s)
				}
			}
		}
	}
	for i := range in.Contracts {
		for _, q := range in.Contracts[i].Prereqs {
			if !seen[q] {
				return fmt.Errorf("contractopt: contract %q has unknown prereq %q", in.Contracts[i].ID, q)
			}
			if q == in.Contracts[i].ID {
				return fmt.Errorf("contractopt: contract %q is its own prereq", q)
			}
		}
	}
	return nil
}

func (in *Instance) index() map[string]int {
	idx := make(map[string]int, len(in.Contracts))
	for i := range in.Contracts {
		idx[in.Contracts[i].ID] = i
	}
	return idx
}

// startsOf returns the candidate starts of c (the fixed start when locked).
func startsOf(c *Contract) []int {
	if c.Locked {
		return []int{c.Start}
	}
	return c.Starts
}

// contractUsage is the total resource consumption of one contract.
func contractUsage(c *Contract) int64 {
	var u int64
	for _, d := range c.Demand {
		u += d
	}
	return u * int64(c.Duration)
}

// Evaluate fully verifies an assignment and computes its objective values.
// It returns a descriptive error for the first violated constraint.
func (in *Instance) Evaluate(assign map[string]int) (Solution, error) {
	if err := in.Validate(); err != nil {
		return Solution{}, err
	}
	idx := in.index()
	for id := range assign {
		if _, ok := idx[id]; !ok {
			return Solution{}, fmt.Errorf("contractopt: assignment selects unknown contract %q", id)
		}
	}
	if len(assign) > in.MaxSelect {
		return Solution{}, fmt.Errorf("contractopt: %d contracts selected, limit is %d", len(assign), in.MaxSelect)
	}
	used := make([][]int64, in.Periods)
	for p := range used {
		used[p] = make([]int64, in.Resources)
	}
	groups := make(map[string]string)
	var revenue, usage int64
	for i := range in.Contracts {
		c := &in.Contracts[i]
		s, sel := assign[c.ID]
		if c.Locked {
			if !sel || s != c.Start {
				return Solution{}, fmt.Errorf("contractopt: locked contract %q must be selected at start %d", c.ID, c.Start)
			}
		}
		if !sel {
			continue
		}
		ok := false
		for _, cand := range startsOf(c) {
			if cand == s {
				ok = true
			}
		}
		if !ok {
			return Solution{}, fmt.Errorf("contractopt: contract %q start %d is not a candidate start", c.ID, s)
		}
		if c.Group != "" {
			if other, busy := groups[c.Group]; busy {
				return Solution{}, fmt.Errorf("contractopt: mutex group %q holds both %q and %q", c.Group, other, c.ID)
			}
			groups[c.Group] = c.ID
		}
		for _, qid := range c.Prereqs {
			qs, qsel := assign[qid]
			if !qsel {
				return Solution{}, fmt.Errorf("contractopt: contract %q requires unselected prereq %q", c.ID, qid)
			}
			q := &in.Contracts[idx[qid]]
			if qs+q.Duration > s {
				return Solution{}, fmt.Errorf("contractopt: prereq %q of %q not finished before start %d", qid, c.ID, s)
			}
		}
		for p := s; p < s+c.Duration; p++ {
			for r := 0; r < in.Resources; r++ {
				used[p][r] += c.Demand[r]
				if used[p][r] > in.Capacity[p][r] {
					return Solution{}, fmt.Errorf("contractopt: capacity exceeded at period %d resource %d", p, r)
				}
			}
		}
		revenue += c.Revenue
		usage += contractUsage(c)
	}
	return Solution{Assign: assign, Revenue: revenue, Usage: usage}, nil
}

// better reports whether objective (r1, u1) beats (r2, u2): revenue first,
// then smaller total resource usage.
func better(r1, u1, r2, u2 int64) bool {
	return r1 > r2 || (r1 == r2 && u1 < u2)
}
