package contractopt

import (
	"fmt"
	"math/rand"
)

// randInstance builds a random small instance. Prerequisite edges only point
// from earlier to later contracts, so the graph is acyclic by construction.
// Candidate start lists are capped at 3 entries to keep brute-force
// enumeration cheap.
func randInstance(rng *rand.Rand, n int) *Instance {
	periods := 3 + rng.Intn(4)   // 3..6
	resources := 1 + rng.Intn(3) // 1..3
	cap := make([][]int64, periods)
	for p := range cap {
		cap[p] = make([]int64, resources)
		for r := range cap[p] {
			cap[p][r] = int64(3 + rng.Intn(8))
		}
	}
	inst := &Instance{Capacity: cap}
	for i := 0; i < n; i++ {
		dur := 1 + rng.Intn(2)
		maxStart := periods - dur
		var starts []int
		for s := 0; s <= maxStart; s++ {
			if rng.Intn(2) == 0 {
				starts = append(starts, s)
			}
		}
		if len(starts) == 0 {
			starts = []int{rng.Intn(maxStart + 1)}
		}
		for len(starts) > 3 {
			k := rng.Intn(len(starts))
			starts = append(starts[:k], starts[k+1:]...)
		}
		usage := make([]int64, resources)
		for r := range usage {
			usage[r] = int64(rng.Intn(5))
		}
		c := Contract{
			ID:       fmt.Sprintf("C%d", i),
			Revenue:  int64(rng.Intn(26) - 5), // -5..20, includes non-positive
			Usage:    usage,
			Duration: dur,
			Starts:   starts,
		}
		for j := 0; j < i; j++ {
			if rng.Intn(100) < 12 {
				c.Prereqs = append(c.Prereqs, fmt.Sprintf("C%d", j))
			}
		}
		if rng.Intn(100) < 35 {
			c.Group = fmt.Sprintf("G%d", rng.Intn(3))
		}
		inst.Contracts = append(inst.Contracts, c)
	}
	// Lock some contracts that have no prerequisites and no group, so the
	// locked set itself is satisfiable with high probability.
	for i := range inst.Contracts {
		c := &inst.Contracts[i]
		if len(c.Prereqs) == 0 && c.Group == "" && rng.Intn(100) < 15 {
			c.Locked = true
			c.LockedStart = c.Starts[rng.Intn(len(c.Starts))]
		}
	}
	return inst
}

// mutateContract rewrites one unlocked contract with random revenue, usage
// and candidate starts, keeping the instance valid.
func mutateContract(rng *rand.Rand, inst *Instance, i int) {
	c := &inst.Contracts[i]
	c.Revenue = int64(rng.Intn(26) - 5)
	for r := range c.Usage {
		c.Usage[r] = int64(rng.Intn(5))
	}
	maxStart := inst.NumPeriods() - c.Duration
	var starts []int
	for s := 0; s <= maxStart; s++ {
		if rng.Intn(2) == 0 {
			starts = append(starts, s)
		}
	}
	if len(starts) == 0 {
		starts = []int{rng.Intn(maxStart + 1)}
	}
	for len(starts) > 3 {
		k := rng.Intn(len(starts))
		starts = append(starts[:k], starts[k+1:]...)
	}
	c.Starts = starts
}
