// Package sched solves single-machine scheduling problems with precedence
// constraints, release times and class-dependent setup times.
//
// Objective (lexicographic): minimize the maximum lateness Lmax first,
// then minimize the total completion time sum(C_j).
package sched

import (
	"errors"
	"fmt"
	"sort"
)

// MaxJobs is the maximum number of jobs an instance may contain.
const MaxJobs = 16

// ExactLimit is the maximum number of jobs for which Solve enumerates
// all precedence-feasible permutations exhaustively.
const ExactLimit = 8

// Job describes a single operation to schedule.
type Job struct {
	ID    string   // unique identifier
	Proc  int      // processing time, must be > 0
	Rel   int      // release time, must be >= 0
	Due   int      // due date; lateness = completion - Due
	Class int      // category index into Instance.Setups
	Pred  []string // IDs of jobs that must complete before this one starts
}

// Instance is a full scheduling problem.
type Instance struct {
	Jobs []Job
	// Setups[c1][c2] is the setup time incurred when a job of class c2
	// is scheduled immediately after a job of class c1. The setup is
	// performed after the previous job completes and may overlap the
	// next job's release time (the job starts at max(now+setup, Rel)).
	Setups [][]int
}

// CycleError reports a precedence cycle; Cycle lists job IDs forming the
// loop, with the first ID repeated at the end (e.g. [A B C A]).
type CycleError struct {
	Cycle []string
}

func (e *CycleError) Error() string {
	return fmt.Sprintf("precedence cycle detected: %v", e.Cycle)
}

// Validate checks structural integrity of the instance and detects
// precedence cycles, returning a *CycleError with the offending loop.
func (in *Instance) Validate() error {
	if len(in.Jobs) == 0 {
		return errors.New("sched: instance has no jobs")
	}
	if len(in.Jobs) > MaxJobs {
		return fmt.Errorf("sched: %d jobs exceeds maximum of %d", len(in.Jobs), MaxJobs)
	}
	idx := make(map[string]int, len(in.Jobs))
	maxClass := -1
	for i, j := range in.Jobs {
		if j.ID == "" {
			return fmt.Errorf("sched: job %d has empty ID", i)
		}
		if _, dup := idx[j.ID]; dup {
			return fmt.Errorf("sched: duplicate job ID %q", j.ID)
		}
		idx[j.ID] = i
		if j.Proc <= 0 {
			return fmt.Errorf("sched: job %q has non-positive processing time %d", j.ID, j.Proc)
		}
		if j.Rel < 0 {
			return fmt.Errorf("sched: job %q has negative release time %d", j.ID, j.Rel)
		}
		if j.Class < 0 {
			return fmt.Errorf("sched: job %q has negative class %d", j.ID, j.Class)
		}
		if j.Class > maxClass {
			maxClass = j.Class
		}
	}
	if maxClass >= 0 && len(in.Setups) > 0 {
		if len(in.Setups) <= maxClass {
			return fmt.Errorf("sched: setup matrix has %d rows, need at least %d", len(in.Setups), maxClass+1)
		}
		for r, row := range in.Setups[:maxClass+1] {
			if len(row) <= maxClass {
				return fmt.Errorf("sched: setup matrix row %d has %d entries, need at least %d", r, len(row), maxClass+1)
			}
			for c, v := range row[:maxClass+1] {
				if v < 0 {
					return fmt.Errorf("sched: negative setup time Setups[%d][%d]=%d", r, c, v)
				}
			}
		}
	}
	for _, j := range in.Jobs {
		for _, p := range j.Pred {
			if p == j.ID {
				return &CycleError{Cycle: []string{p, p}}
			}
			if _, ok := idx[p]; !ok {
				return fmt.Errorf("sched: job %q references unknown predecessor %q", j.ID, p)
			}
		}
	}
	if cyc := findCycle(in.Jobs, idx); cyc != nil {
		return &CycleError{Cycle: cyc}
	}
	return nil
}

// findCycle runs an iterative DFS over the precedence edges (job -> its
// predecessors) and returns one concrete cycle if the graph has one.
func findCycle(jobs []Job, idx map[string]int) []string {
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make([]int, len(jobs))
	parent := make([]int, len(jobs))
	for i := range parent {
		parent[i] = -1
	}
	order := make([]int, len(jobs))
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool { return jobs[order[a]].ID < jobs[order[b]].ID })

	for _, s := range order {
		if color[s] != white {
			continue
		}
		type frame struct{ node, next int }
		stack := []frame{{s, 0}}
		color[s] = gray
		for len(stack) > 0 {
			f := &stack[len(stack)-1]
			j := jobs[f.node]
			if f.next < len(j.Pred) {
				p := idx[j.Pred[f.next]]
				f.next++
				switch color[p] {
				case white:
					color[p] = gray
					parent[p] = f.node
					stack = append(stack, frame{p, 0})
				case gray:
					// Reconstruct cycle: p ... f.node -> p.
					cyc := []string{jobs[p].ID}
					for cur := f.node; cur != p; cur = parent[cur] {
						cyc = append(cyc, jobs[cur].ID)
					}
					cyc = append(cyc, jobs[p].ID)
					// Reverse so it reads along the precedence direction.
					for l, r := 0, len(cyc)-1; l < r; l, r = l+1, r-1 {
						cyc[l], cyc[r] = cyc[r], cyc[l]
					}
					return cyc
				}
			} else {
				color[f.node] = black
				stack = stack[:len(stack)-1]
			}
		}
	}
	return nil
}
