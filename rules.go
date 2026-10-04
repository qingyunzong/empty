// Package rules maintains a system of difference constraints of the form
// x[to] - x[from] <= weight. Every derived (transitive) edge is bound to the
// original constraint IDs it was derived from. When a newly added constraint
// closes a negative cycle, the library reports a minimum-cardinality
// infeasible set of source constraint IDs. Deleting constraints recomputes
// and restores feasible potentials.
package rules

import (
	"errors"
	"sort"
)

// MaxConstraints is the maximum number of live constraints the system
// holds. The cap keeps exhaustive minimisation (2^18 subsets) tractable.
const MaxConstraints = 18

var (
	ErrTooManyConstraints = errors.New("rules: at most 18 live constraints")
	ErrUnknownConstraint  = errors.New("rules: unknown constraint id")
	ErrUnknownVariable    = errors.New("rules: variable index out of range")
)

// Constraint is a difference constraint x[To] - x[From] <= Weight.
type Constraint struct {
	ID     int
	From   int
	To     int
	Weight int64
}

// DerivedEdge is the tightest derived bound x[to] - x[from] <= Weight,
// together with the sorted IDs of the original constraints it stems from.
type DerivedEdge struct {
	Weight  int64
	Sources []int
}

// System is a difference-constraint rule base over numVars variables.
type System struct {
	numVars     int
	nextID      int
	constraints map[int]Constraint
	potentials  []int64
	feasible    bool
	derived     map[[2]int]DerivedEdge
}

// NewSystem returns an empty, feasible system over numVars variables.
func NewSystem(numVars int) *System {
	return &System{
		numVars:     numVars,
		constraints: map[int]Constraint{},
		potentials:  make([]int64, numVars),
		feasible:    true,
		derived:     map[[2]int]DerivedEdge{},
	}
}

// Add inserts a constraint and returns its ID. If the constraint closes a
// negative cycle it stays in the system, the previous feasible potentials
// are kept, and conflict holds a minimum-cardinality infeasible set of
// source constraint IDs (nil when the system remains feasible).
func (s *System) Add(from, to int, weight int64) (id int, conflict []int, err error) {
	if from < 0 || from >= s.numVars || to < 0 || to >= s.numVars {
		return 0, nil, ErrUnknownVariable
	}
	if len(s.constraints) >= MaxConstraints {
		return 0, nil, ErrTooManyConstraints
	}
	id = s.nextID
	s.nextID++
	s.constraints[id] = Constraint{ID: id, From: from, To: to, Weight: weight}
	if s.recompute() {
		return id, nil, nil
	}
	return id, minimalInfeasible(s.numVars, s.active()), nil
}

// Delete removes a constraint and recomputes potentials, restoring a
// feasible potential assignment once the remaining constraints permit it.
func (s *System) Delete(id int) error {
	if _, ok := s.constraints[id]; !ok {
		return ErrUnknownConstraint
	}
	delete(s.constraints, id)
	s.recompute()
	return nil
}

// Feasible reports whether the live constraints admit a potential
// assignment.
func (s *System) Feasible() bool { return s.feasible }

// Potentials returns the most recent feasible potential assignment. It
// satisfies every live constraint whenever Feasible is true.
func (s *System) Potentials() []int64 {
	out := make([]int64, len(s.potentials))
	copy(out, s.potentials)
	return out
}

// Constraints returns the live constraints sorted by ID.
func (s *System) Constraints() []Constraint {
	out := s.active()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Derived returns the tightest derived edge from -> to and the IDs of the
// original constraints it was derived from.
func (s *System) Derived(from, to int) (DerivedEdge, bool) {
	e, ok := s.derived[[2]int{from, to}]
	return e, ok
}

func (s *System) active() []Constraint {
	out := make([]Constraint, 0, len(s.constraints))
	for _, c := range s.constraints {
		out = append(out, c)
	}
	return out
}

// recompute re-solves the system. On success it stores fresh potentials and
// derived edges; on failure it keeps the last feasible state and reports
// infeasibility.
func (s *System) recompute() bool {
	cs := s.active()
	dist, ok := bellmanFord(s.numVars, cs)
	if !ok {
		s.feasible = false
		return false
	}
	s.potentials = dist
	s.feasible = true
	s.derived = floydWarshall(s.numVars, cs)
	return true
}

// bellmanFord computes shortest-path potentials with a virtual zero-weight
// super source (all distances start at 0). ok is false on a negative cycle.
func bellmanFord(numVars int, cs []Constraint) (dist []int64, ok bool) {
	dist = make([]int64, numVars)
	for i := 0; i < numVars; i++ {
		relaxed := false
		for _, c := range cs {
			if dist[c.To] > dist[c.From]+c.Weight {
				dist[c.To] = dist[c.From] + c.Weight
				relaxed = true
			}
		}
		if !relaxed {
			return dist, true
		}
	}
	for _, c := range cs {
		if dist[c.To] > dist[c.From]+c.Weight {
			return nil, false
		}
	}
	return dist, true
}

func feasible(numVars int, cs []Constraint) bool {
	_, ok := bellmanFord(numVars, cs)
	return ok
}

const inf = int64(1) << 60

// floydWarshall derives the tightest bound for every ordered variable pair
// and binds each derived edge to the source constraint IDs on its witness
// path. Ties prefer fewer, then lexicographically smaller, source IDs.
func floydWarshall(numVars int, cs []Constraint) map[[2]int]DerivedEdge {
	dist := make([][]int64, numVars)
	src := make([][][]int, numVars)
	for i := range dist {
		dist[i] = make([]int64, numVars)
		src[i] = make([][]int, numVars)
		for j := range dist[i] {
			dist[i][j] = inf
		}
		dist[i][i] = 0
	}
	for _, c := range cs {
		if c.Weight < dist[c.From][c.To] ||
			(c.Weight == dist[c.From][c.To] && betterSources([]int{c.ID}, src[c.From][c.To])) {
			dist[c.From][c.To] = c.Weight
			src[c.From][c.To] = []int{c.ID}
		}
	}
	for k := 0; k < numVars; k++ {
		for i := 0; i < numVars; i++ {
			if dist[i][k] == inf {
				continue
			}
			for j := 0; j < numVars; j++ {
				if dist[k][j] == inf {
					continue
				}
				cand := dist[i][k] + dist[k][j]
				alt := mergeIDs(src[i][k], src[k][j])
				switch {
				case cand < dist[i][j]:
					dist[i][j] = cand
					src[i][j] = alt
				case cand == dist[i][j] && betterSources(alt, src[i][j]):
					src[i][j] = alt
				}
			}
		}
	}
	out := map[[2]int]DerivedEdge{}
	for i := 0; i < numVars; i++ {
		for j := 0; j < numVars; j++ {
			if i != j && dist[i][j] != inf {
				out[[2]int{i, j}] = DerivedEdge{Weight: dist[i][j], Sources: src[i][j]}
			}
		}
	}
	return out
}

// betterSources reports whether a is preferable to b: fewer source IDs
// wins, then lexicographic order. A nil b loses to any non-nil a.
func betterSources(a, b []int) bool {
	if len(a) == 0 {
		return false
	}
	if len(b) == 0 {
		return true
	}
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

// mergeIDs unions two sorted ID lists, keeping the result sorted and
// duplicate-free.
func mergeIDs(a, b []int) []int {
	out := make([]int, 0, len(a)+len(b))
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i] < b[j]:
			out = append(out, a[i])
			i++
		case a[i] > b[j]:
			out = append(out, b[j])
			j++
		default:
			out = append(out, a[i])
			i++
			j++
		}
	}
	return append(append(out, a[i:]...), b[j:]...)
}

// minimalInfeasible enumerates subsets of cs in increasing cardinality and
// returns the sorted IDs of a smallest infeasible subset, breaking ties by
// lexicographic ID order. It returns nil when cs itself is feasible.
func minimalInfeasible(numVars int, cs []Constraint) []int {
	byID := make(map[int]Constraint, len(cs))
	ids := make([]int, 0, len(cs))
	for _, c := range cs {
		byID[c.ID] = c
		ids = append(ids, c.ID)
	}
	sort.Ints(ids)
	for size := 1; size <= len(ids); size++ {
		var best []int
		picked := make([]int, 0, size)
		var rec func(start int)
		rec = func(start int) {
			if len(picked) == size {
				sub := make([]Constraint, size)
				for i, id := range picked {
					sub[i] = byID[id]
				}
				if !feasible(numVars, sub) && betterSources(picked, best) {
					best = append([]int(nil), picked...)
				}
				return
			}
			for i := start; i <= len(ids)-(size-len(picked)); i++ {
				picked = append(picked, ids[i])
				rec(i + 1)
				picked = picked[:len(picked)-1]
			}
		}
		rec(0)
		if best != nil {
			return best
		}
	}
	return nil
}
