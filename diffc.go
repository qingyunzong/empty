// Package diffc maintains a set of integer difference constraints of the
// form x - y <= c and decides feasibility, producing either feasible
// potentials or a negative cycle as a certificate.
//
// The system supports snapshots (old snapshots stay readable and their
// certificates stay verifiable), undo of mutations, and atomic batch
// edits. Only the Go standard library is used.
package diffc

import (
	"errors"
	"fmt"
	"sort"
)

// Constraint is a single integer difference constraint X - Y <= C.
// ID is assigned by the System when the constraint is added.
type Constraint struct {
	ID   int
	X, Y int
	C    int64
}

// Edit is one atomic batch operation: either an add or a remove.
type Edit struct {
	// Remove selects removal of the constraint with the given ID.
	Remove bool
	ID     int
	// X, Y, C describe the constraint to add when Remove is false.
	X, Y int
	C    int64
}

// Certificate is the result of solving a constraint snapshot.
// Exactly one of the two forms is populated:
//   - Feasible: Potentials assigns every variable a value with
//     pot[X]-pot[Y] <= C for every constraint.
//   - Infeasible: Cycle lists constraint IDs forming a negative cycle.
type Certificate struct {
	Feasible   bool
	Potentials map[int]int64
	Cycle      []int
}

// System is a mutable set of difference constraints with undo history.
// The zero value is ready to use.
type System struct {
	cons    map[int]Constraint
	nextID  int
	history []map[int]Constraint
}

// New returns an empty constraint system.
func New() *System { return &System{cons: map[int]Constraint{}, nextID: 1} }

func (s *System) ensure() {
	if s.cons == nil {
		s.cons = map[int]Constraint{}
	}
	if s.nextID == 0 {
		s.nextID = 1
	}
}

func cloneMap(m map[int]Constraint) map[int]Constraint {
	c := make(map[int]Constraint, len(m))
	for k, v := range m {
		c[k] = v
	}
	return c
}

func (s *System) pushHistory() {
	s.history = append(s.history, cloneMap(s.cons))
}

// Add inserts the constraint x - y <= c and returns its new ID.
func (s *System) Add(x, y int, c int64) int {
	s.ensure()
	s.pushHistory()
	id := s.nextID
	s.nextID++
	s.cons[id] = Constraint{ID: id, X: x, Y: y, C: c}
	return id
}

// Remove deletes the constraint with the given ID. It reports whether
// the constraint existed.
func (s *System) Remove(id int) bool {
	s.ensure()
	if _, ok := s.cons[id]; !ok {
		return false
	}
	s.pushHistory()
	delete(s.cons, id)
	return true
}

// Apply performs a batch of edits atomically: either every edit is
// applied or none is. It returns the IDs assigned to added constraints
// in edit order. A removal of a missing or duplicated ID fails the
// whole batch without changing the system.
func (s *System) Apply(edits ...Edit) ([]int, error) {
	s.ensure()
	removed := map[int]bool{}
	for i, e := range edits {
		if !e.Remove {
			continue
		}
		if _, ok := s.cons[e.ID]; !ok {
			return nil, fmt.Errorf("edit %d: constraint %d does not exist", i, e.ID)
		}
		if removed[e.ID] {
			return nil, fmt.Errorf("edit %d: constraint %d removed twice", i, e.ID)
		}
		removed[e.ID] = true
	}
	s.pushHistory()
	ids := make([]int, 0, len(edits))
	for _, e := range edits {
		if e.Remove {
			delete(s.cons, e.ID)
			continue
		}
		id := s.nextID
		s.nextID++
		s.cons[id] = Constraint{ID: id, X: e.X, Y: e.Y, C: e.C}
		ids = append(ids, id)
	}
	return ids, nil
}

// Undo reverts the most recent mutation (Add, Remove or Apply). It
// reports whether there was anything to undo. Certificates obtained
// before the undone mutation become valid for the restored state again.
func (s *System) Undo() bool {
	if len(s.history) == 0 {
		return false
	}
	s.cons = s.history[len(s.history)-1]
	s.history = s.history[:len(s.history)-1]
	return true
}

// Len returns the number of live constraints.
func (s *System) Len() int { return len(s.cons) }

// Snapshot returns an immutable, independently readable view of the
// current constraints. Later mutations of the System do not affect it.
func (s *System) Snapshot() Snapshot {
	s.ensure()
	return Snapshot{cons: cloneMap(s.cons)}
}

// Snapshot is an immutable set of constraints that can be solved and
// verified independently of the System it was taken from.
type Snapshot struct {
	cons map[int]Constraint
}

// Constraints returns the snapshot's constraints ordered by ID.
func (snap Snapshot) Constraints() []Constraint {
	out := make([]Constraint, 0, len(snap.cons))
	for _, c := range snap.cons {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Len returns the number of constraints in the snapshot.
func (snap Snapshot) Len() int { return len(snap.cons) }

// satAdd adds two int64 values with saturation to avoid overflow.
func satAdd(a, b int64) int64 {
	if b > 0 && a > maxInt64Const-b {
		return maxInt64Const
	}
	if b < 0 && a < minInt64Const-b {
		return minInt64Const
	}
	return a + b
}

const (
	maxInt64Const = int64(^uint64(0) >> 1)
	minInt64Const = -maxInt64Const - 1
)

// Solve runs Bellman-Ford from a virtual zero-weight source and returns
// a certificate: feasible potentials, or the IDs of a negative cycle.
// The result is deterministic for a given snapshot.
func (snap Snapshot) Solve() Certificate {
	cons := snap.Constraints()
	byID := make(map[int]Constraint, len(cons))
	nodes := map[int]bool{}
	for _, c := range cons {
		byID[c.ID] = c
		nodes[c.X] = true
		nodes[c.Y] = true
	}
	n := len(nodes)
	dist := make(map[int]int64, n) // virtual source: all distances start at 0
	pred := make(map[int]int, n)   // node -> constraint ID used to relax it

	relaxedNode := -1
	hasRelaxed := false
	for i := 0; i < n; i++ {
		hasRelaxed = false
		for _, c := range cons {
			if d := satAdd(dist[c.Y], c.C); d < dist[c.X] {
				dist[c.X] = d
				pred[c.X] = c.ID
				relaxedNode = c.X
				hasRelaxed = true
			}
		}
		if !hasRelaxed {
			break
		}
	}

	if !hasRelaxed {
		pot := make(map[int]int64, n)
		for v := range nodes {
			pot[v] = dist[v]
		}
		return Certificate{Feasible: true, Potentials: pot}
	}

	// A node relaxed in the n-th round lies on or reaches a negative
	// cycle; walk predecessors n times to land inside the cycle.
	v := relaxedNode
	for i := 0; i < n; i++ {
		v = byID[pred[v]].Y
	}
	start := v
	var cycle []int
	for {
		id := pred[v]
		cycle = append(cycle, id)
		v = byID[id].Y
		if v == start {
			break
		}
	}
	// Reverse so consecutive constraints chain head-to-tail:
	// cycle[i].X == cycle[i+1].Y.
	for i, j := 0, len(cycle)-1; i < j; i, j = i+1, j-1 {
		cycle[i], cycle[j] = cycle[j], cycle[i]
	}
	return Certificate{Feasible: false, Cycle: cycle}
}

// Verify independently checks a certificate against this snapshot.
// It returns nil when the certificate is valid.
func (snap Snapshot) Verify(cert Certificate) error {
	if cert.Feasible {
		return snap.VerifyPotentials(cert.Potentials)
	}
	return snap.VerifyCycle(cert.Cycle)
}

// VerifyPotentials checks that pot assigns every variable a value and
// satisfies every constraint of the snapshot.
func (snap Snapshot) VerifyPotentials(pot map[int]int64) error {
	for _, c := range snap.Constraints() {
		px, ok := pot[c.X]
		if !ok {
			return fmt.Errorf("potentials missing variable %d", c.X)
		}
		py, ok := pot[c.Y]
		if !ok {
			return fmt.Errorf("potentials missing variable %d", c.Y)
		}
		if satAdd(px, -py) > c.C {
			return fmt.Errorf("constraint %d violated: %d - %d > %d", c.ID, px, py, c.C)
		}
	}
	return nil
}

// VerifyCycle checks that cycle lists existing constraint IDs forming a
// directed cycle whose total weight is negative.
func (snap Snapshot) VerifyCycle(cycle []int) error {
	if len(cycle) == 0 {
		return errors.New("empty cycle")
	}
	byID := make(map[int]Constraint, len(snap.cons))
	for _, c := range snap.cons {
		byID[c.ID] = c
	}
	edges := make([]Constraint, len(cycle))
	seen := make(map[int]bool, len(cycle))
	for i, id := range cycle {
		c, ok := byID[id]
		if !ok {
			return fmt.Errorf("cycle references unknown constraint %d", id)
		}
		if seen[id] {
			return fmt.Errorf("cycle repeats constraint %d", id)
		}
		seen[id] = true
		edges[i] = c
	}
	var sum int64
	saturatedNeg := false
	for i, c := range edges {
		next := edges[(i+1)%len(edges)]
		if c.X != next.Y {
			return fmt.Errorf("constraints %d and %d do not chain: %d -> %d vs %d -> %d",
				c.ID, next.ID, c.Y, c.X, next.Y, next.X)
		}
		if c.C < 0 && sum < minInt64Const-c.C {
			saturatedNeg = true
		} else {
			sum += c.C
		}
	}
	if sum >= 0 && !saturatedNeg {
		return fmt.Errorf("cycle weight %d is not negative", sum)
	}
	return nil
}
