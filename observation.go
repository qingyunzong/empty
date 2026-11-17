package formal

import (
	"fmt"
	"time"
)

// UnlimitedCapacity can be used when a caller does not want to constrain the
// number of schedulable pods.
const UnlimitedCapacity = int(^uint(0) >> 1)

// Observation is the aggregate workload state after the previous action has
// been applied.
//
// Total includes ready, not-ready, and terminating pods because all of them
// still occupy a node slot until termination completes. Available includes only
// ready pods that are not terminating. Terminating pods are excluded from
// Available conservatively so that starting a termination can never later
// surprise the availability floor.
type Observation struct {
	Now         time.Duration
	Total       int
	Available   int
	Terminating int
	Capacity    int
}

// Unready returns the number of non-terminating pods that are not available.
func (o Observation) Unready() int {
	return o.Total - o.Available - o.Terminating
}

// NonTerminating returns the replicas that are not already committed to
// termination.
func (o Observation) NonTerminating() int {
	return o.Total - o.Terminating
}

// Validate checks the aggregate invariants of an Observation.
func (o Observation) Validate() error {
	if o.Now < 0 {
		return fmt.Errorf("observation time must not be negative: %s", o.Now)
	}
	if o.Total < 0 || o.Available < 0 || o.Terminating < 0 || o.Capacity < 0 {
		return fmt.Errorf("observation counts and capacity must not be negative: %+v", o)
	}
	if o.Terminating > o.Total {
		return fmt.Errorf("terminating replicas (%d) exceed total replicas (%d)", o.Terminating, o.Total)
	}
	if o.Available > o.Total-o.Terminating {
		return fmt.Errorf("available replicas (%d) exceed non-terminating replicas (%d)", o.Available, o.Total-o.Terminating)
	}
	return nil
}
