// Package rulelib maintains a system of difference constraints
// (x[to] - x[from] <= weight). Every constraint carries the ID of the
// source it originated from, and every derived (implied) edge is bound
// to the source IDs of the original constraints that produce it.
//
// When a newly added constraint closes a negative cycle, the library
// reports an infeasible set with the fewest distinct source IDs. The
// system supports at most MaxConstraints constraints so that the
// minimum infeasible set can be computed by exhaustive subset
// enumeration. Deleting constraints restores feasible potentials.
package rulelib

import (
	"errors"
	"fmt"
	"sort"
)

// MaxConstraints is the maximum number of constraints the system holds.
// The minimum infeasible set is found by enumerating constraint
// subsets, which stays cheap up to this bound (2^18 subsets).
const MaxConstraints = 18

// ErrTooManyConstraints is returned by Add when the system already
// holds MaxConstraints constraints.
var ErrTooManyConstraints = errors.New("rulelib: at most 18 constraints")

// Constraint is a difference constraint x[To] - x[From] <= Weight.
// ID identifies the original source the constraint was derived from.
type Constraint struct {
	ID     int
	From   int
	To     int
	Weight int64
}

// System is a set of difference constraints over variables 0..NumVars-1
// together with feasible potentials when the set is satisfiable.
type System struct {
	numVars     int
	constraints []Constraint
	potentials  []int64
	feasible    bool
}

// New returns an empty, feasible system over numVars variables.
func New(numVars int) *System {
	if numVars < 0 {
		numVars = 0
	}
	return &System{
		numVars:    numVars,
		potentials: make([]int64, numVars),
		feasible:   true,
	}
}

// Feasible reports whether the current constraint set is satisfiable.
func (s *System) Feasible() bool { return s.feasible }

// NumVars returns the number of variables in the system.
func (s *System) NumVars() int { return s.numVars }

// Constraints returns a copy of the active constraints.
func (s *System) Constraints() []Constraint {
	return append([]Constraint(nil), s.constraints...)
}

// Potentials returns feasible potentials (one per variable) satisfying
// every constraint, or false when the system is infeasible.
func (s *System) Potentials() ([]int64, bool) {
	if !s.feasible {
		return nil, false
	}
	return append([]int64(nil), s.potentials...), true
}

// Add inserts c into the system. It returns nil when the enlarged
// system stays feasible and potentials have been updated. When c closes
// a negative cycle, Add returns the sorted source IDs of an infeasible
// constraint subset with the fewest distinct source IDs; the constraint
// remains in the system (which is then infeasible) until Delete removes
// enough sources to restore feasibility.
func (s *System) Add(c Constraint) ([]int, error) {
	if c.From < 0 || c.From >= s.numVars || c.To < 0 || c.To >= s.numVars {
		return nil, fmt.Errorf("rulelib: constraint variables (%d, %d) out of range [0, %d)", c.From, c.To, s.numVars)
	}
	if len(s.constraints) >= MaxConstraints {
		return nil, ErrTooManyConstraints
	}
	s.constraints = append(s.constraints, c)
	s.recompute()
	if s.feasible {
		return nil, nil
	}
	return minInfeasibleSources(s.numVars, s.constraints), nil
}

// Delete removes every constraint whose source ID is listed and
// recomputes feasibility. Once the constraints breaking feasibility are
// removed, feasible potentials are restored.
func (s *System) Delete(ids ...int) {
	if len(ids) == 0 {
		return
	}
	drop := make(map[int]bool, len(ids))
	for _, id := range ids {
		drop[id] = true
	}
	kept := make([]Constraint, 0, len(s.constraints))
	for _, c := range s.constraints {
		if !drop[c.ID] {
			kept = append(kept, c)
		}
	}
	s.constraints = kept
	s.recompute()
}

// DerivedBound returns the tightest derived edge from -> to, i.e. the
// smallest weight such that x[to] - x[from] <= weight is implied by the
// active constraints, together with the sorted source IDs of the
// original constraints the derived edge is bound to. It reports false
// when the system is infeasible or to is unreachable from from.
func (s *System) DerivedBound(from, to int) (int64, []int, bool) {
	if !s.feasible || from < 0 || from >= s.numVars || to < 0 || to >= s.numVars {
		return 0, nil, false
	}
	const inf = int64(1) << 62
	dist := make([]int64, s.numVars)
	parent := make([]int, s.numVars)
	for i := range dist {
		dist[i] = inf
		parent[i] = -1
	}
	dist[from] = 0
	for i := 0; i < s.numVars; i++ {
		updated := false
		for ci, c := range s.constraints {
			if dist[c.From] != inf && dist[c.From]+c.Weight < dist[c.To] {
				dist[c.To] = dist[c.From] + c.Weight
				parent[c.To] = ci
				updated = true
			}
		}
		if !updated {
			break
		}
	}
	if dist[to] == inf {
		return 0, nil, false
	}
	seen := make(map[int]bool)
	var sources []int
	for v := to; v != from; {
		ci := parent[v]
		if ci < 0 {
			return 0, nil, false
		}
		c := s.constraints[ci]
		if !seen[c.ID] {
			seen[c.ID] = true
			sources = append(sources, c.ID)
		}
		v = c.From
	}
	sort.Ints(sources)
	return dist[to], sources, true
}

// recompute recomputes feasibility and, when feasible, potentials.
func (s *System) recompute() {
	pot, ok := feasiblePotentials(s.numVars, s.constraints)
	s.feasible = ok
	if ok {
		s.potentials = pot
	}
}

// feasiblePotentials runs Bellman-Ford from a virtual super source
// (all distances start at 0). A negative cycle reachable in the
// constraint graph makes the system infeasible.
func feasiblePotentials(numVars int, cs []Constraint) ([]int64, bool) {
	dist := make([]int64, numVars)
	for i := 0; i <= numVars; i++ {
		updated := false
		for _, c := range cs {
			if d := dist[c.From] + c.Weight; d < dist[c.To] {
				dist[c.To] = d
				updated = true
			}
		}
		if !updated {
			return dist, true
		}
	}
	return nil, false
}

// minInfeasibleSources enumerates all constraint subsets and returns
// the sorted source IDs of an infeasible subset with the fewest
// distinct source IDs. The caller must guarantee cs is infeasible.
func minInfeasibleSources(numVars int, cs []Constraint) []int {
	m := len(cs)
	best := m + 1
	var bestIDs []int
	for mask := 1; mask < (1 << m); mask++ {
		idSeen := make(map[int]struct{}, m)
		var sub []Constraint
		for i := 0; i < m; i++ {
			if mask>>i&1 == 1 {
				idSeen[cs[i].ID] = struct{}{}
				sub = append(sub, cs[i])
			}
		}
		if len(idSeen) >= best {
			continue
		}
		if _, ok := feasiblePotentials(numVars, sub); !ok {
			best = len(idSeen)
			bestIDs = bestIDs[:0]
			for id := range idSeen {
				bestIDs = append(bestIDs, id)
			}
			sort.Ints(bestIDs)
		}
	}
	return bestIDs
}
