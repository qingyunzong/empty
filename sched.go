// Package sched solves single-machine scheduling problems with precedence
// constraints, release times and sequence-dependent category setup times.
//
// The objective is lexicographic: first minimize the maximum lateness
// Lmax = max(C_j - d_j), then minimize the total completion time sum(C_j).
// Instances with at most 8 jobs are solved by exhaustive search (proven
// optimal); larger instances (up to MaxJobs) use a greedy dispatch rule
// followed by insertion local search.
package sched

import (
	"errors"
	"fmt"
	"strings"
)

// MaxJobs is the largest number of jobs an Instance may contain.
const MaxJobs = 16

// ExhaustiveLimit is the largest instance size solved by exhaustive search.
const ExhaustiveLimit = 8

// Job describes a single operation to schedule on the machine.
type Job struct {
	ID       string // human-readable identifier, used in output
	Proc     int64  // processing time (>= 0)
	Release  int64  // earliest start time
	Due      int64  // due date; lateness = completion - Due
	Category int    // setup class; switching categories costs Setup[prev][next]
}

// Instance is a scheduling problem: jobs, precedence edges (i, j) meaning
// job i must complete before job j starts, and a setup matrix indexed by
// category. Setup may be nil, meaning all changeovers take zero time.
type Instance struct {
	Jobs  []Job
	Prec  [][2]int
	Setup [][]int64
}

// CycleError reports a cycle in the precedence graph. Cycle holds the job
// indices along the cycle with the first index repeated at the end.
type CycleError struct {
	Cycle []int
	IDs   []string
}

func (e *CycleError) Error() string {
	return "sched: precedence cycle detected: " + strings.Join(e.IDs, " -> ")
}

// Validate checks structural constraints and rejects cyclic precedence
// graphs, returning a *CycleError that names the offending cycle.
func (in *Instance) Validate() error {
	n := len(in.Jobs)
	if n == 0 {
		return errors.New("sched: instance has no jobs")
	}
	if n > MaxJobs {
		return fmt.Errorf("sched: %d jobs exceeds maximum of %d", n, MaxJobs)
	}
	maxCat := -1
	for i, j := range in.Jobs {
		if j.Proc < 0 {
			return fmt.Errorf("sched: job %d (%s): negative processing time %d", i, j.ID, j.Proc)
		}
		if j.Category < 0 {
			return fmt.Errorf("sched: job %d (%s): negative category %d", i, j.ID, j.Category)
		}
		if j.Category > maxCat {
			maxCat = j.Category
		}
	}
	if in.Setup != nil {
		if len(in.Setup) <= maxCat {
			return fmt.Errorf("sched: setup matrix has %d categories but job uses category %d", len(in.Setup), maxCat)
		}
		for r, row := range in.Setup {
			if len(row) != len(in.Setup) {
				return fmt.Errorf("sched: setup row %d has length %d, want %d", r, len(row), len(in.Setup))
			}
			for c, v := range row {
				if v < 0 {
					return fmt.Errorf("sched: negative setup time at [%d][%d]", r, c)
				}
			}
		}
	}
	for _, e := range in.Prec {
		if e[0] < 0 || e[0] >= n || e[1] < 0 || e[1] >= n {
			return fmt.Errorf("sched: precedence edge (%d, %d) out of range [0, %d)", e[0], e[1], n)
		}
	}
	if cyc, ok := findCycle(n, in.Prec); ok {
		ids := make([]string, len(cyc))
		for i, j := range cyc {
			ids[i] = in.Jobs[j].ID
		}
		return &CycleError{Cycle: cyc, IDs: ids}
	}
	return nil
}

// findCycle returns one cycle (first node repeated at the end) if the
// precedence graph is cyclic, using iterative DFS with three colors.
func findCycle(n int, edges [][2]int) ([]int, bool) {
	adj := make([][]int, n)
	for _, e := range edges {
		adj[e[0]] = append(adj[e[0]], e[1])
	}
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make([]int, n)
	var stack []int
	var cycle []int
	var dfs func(u int) bool
	dfs = func(u int) bool {
		color[u] = gray
		stack = append(stack, u)
		for _, v := range adj[u] {
			switch color[v] {
			case gray:
				idx := 0
				for stack[idx] != v {
					idx++
				}
				cycle = append([]int(nil), stack[idx:]...)
				cycle = append(cycle, v)
				return true
			case white:
				if dfs(v) {
					return true
				}
			}
		}
		stack = stack[:len(stack)-1]
		color[u] = black
		return false
	}
	for u := 0; u < n; u++ {
		if color[u] == white && dfs(u) {
			return cycle, true
		}
	}
	return nil, false
}
