// Package diffconstraints maintains a set of integer difference
// constraints of the form x - y <= c and decides their feasibility.
//
// A solved system yields a certificate: either a feasible potential
// (an assignment of integers to variables satisfying every constraint)
// or a negative cycle expressed as a list of constraint IDs. Every
// certificate can be checked independently of the solver via Verify.
//
// Systems support atomic batch modifications, undo, and immutable
// snapshots that remain readable after the parent system changes.
package diffconstraints

import (
	"errors"
	"fmt"
	"sort"
)

// Constraint represents the integer difference constraint X - Y <= C.
// ID uniquely identifies the constraint within a System.
type Constraint struct {
	ID int
	X  int
	Y  int
	C  int
}

// Certificate is the result of solving a constraint set.
type Certificate interface {
	isCertificate()
}

// Feasible certifies satisfiability: Potentials assigns each variable
// an integer such that for every constraint x - y <= c it holds that
// Potentials[x]-Potentials[y] <= c.
type Feasible struct {
	Potentials map[int]int
}

// Infeasible certifies unsatisfiability: Cycle lists constraint IDs
// forming a cycle whose C values sum to a negative number.
type Infeasible struct {
	Cycle []int
}

func (*Feasible) isCertificate()   {}
func (*Infeasible) isCertificate() {}

// frame is one undo-history entry: a full copy of prior state.
type frame struct {
	cons  map[int]Constraint
	order []int
	cert  Certificate
}

// System is a mutable set of difference constraints with undo history.
type System struct {
	cons  map[int]Constraint
	order []int // constraint IDs in insertion order, for determinism
	cert  Certificate
	hist  []frame
}

// NewSystem returns an empty constraint system.
func NewSystem() *System {
	return &System{cons: make(map[int]Constraint)}
}

// ErrDuplicateID is returned when a batch adds an ID that already exists.
var ErrDuplicateID = errors.New("diffconstraints: duplicate constraint ID")

// ErrUnknownID is returned when a batch removes an ID that does not exist.
var ErrUnknownID = errors.New("diffconstraints: unknown constraint ID")

// Apply atomically applies a batch of removals and additions: removals
// are validated against the current set, additions against the set that
// remains after removals. If any element of the batch is invalid, the
// system is left completely unchanged and an error is returned.
func (s *System) Apply(adds []Constraint, removes []int) error {
	remaining := make(map[int]bool, len(s.cons))
	for id := range s.cons {
		remaining[id] = true
	}
	seenRemove := make(map[int]bool, len(removes))
	for _, id := range removes {
		if !remaining[id] {
			return fmt.Errorf("%w: remove %d", ErrUnknownID, id)
		}
		if seenRemove[id] {
			return fmt.Errorf("%w: remove %d twice", ErrDuplicateID, id)
		}
		seenRemove[id] = true
		delete(remaining, id)
	}
	seenAdd := make(map[int]bool, len(adds))
	for _, c := range adds {
		if remaining[c.ID] {
			return fmt.Errorf("%w: add %d", ErrDuplicateID, c.ID)
		}
		if seenAdd[c.ID] {
			return fmt.Errorf("%w: add %d twice", ErrDuplicateID, c.ID)
		}
		seenAdd[c.ID] = true
		remaining[c.ID] = true
	}

	s.pushHistory()
	for _, id := range removes {
		delete(s.cons, id)
	}
	if len(removes) > 0 {
		next := s.order[:0]
		for _, id := range s.order {
			if !seenRemove[id] {
				next = append(next, id)
			}
		}
		s.order = next
	}
	for _, c := range adds {
		s.cons[c.ID] = c
		s.order = append(s.order, c.ID)
	}
	s.cert = nil // cached certificate no longer matches the constraint set
	return nil
}

// Undo reverts the most recent successful Apply, restoring both the
// constraint set and the certificate that was current at that time.
// It reports whether there was anything to undo.
func (s *System) Undo() bool {
	if len(s.hist) == 0 {
		return false
	}
	f := s.hist[len(s.hist)-1]
	s.hist = s.hist[:len(s.hist)-1]
	s.cons, s.order, s.cert = f.cons, f.order, f.cert
	return true
}

func (s *System) pushHistory() {
	s.hist = append(s.hist, frame{
		cons:  cloneCons(s.cons),
		order: append([]int(nil), s.order...),
		cert:  s.cert,
	})
}

// Snapshot returns an immutable, independent view of the current
// constraint set. It stays readable and solvable no matter how the
// originating System is later modified or undone.
func (s *System) Snapshot() *Snapshot {
	return &Snapshot{cons: cloneCons(s.cons), order: append([]int(nil), s.order...)}
}

// Certificate returns the certificate cached by the most recent Solve,
// or nil if the system has been modified since (or never solved).
func (s *System) Certificate() Certificate { return s.cert }

// Constraints returns the current constraints in insertion order.
func (s *System) Constraints() []Constraint { return listCons(s.cons, s.order) }

// Solve decides feasibility of the current constraint set, caches the
// resulting certificate, and returns it.
func (s *System) Solve() Certificate {
	s.cert = solve(s.cons, s.order)
	return s.cert
}

// Snapshot is an immutable view of a constraint set.
type Snapshot struct {
	cons  map[int]Constraint
	order []int
}

// Constraints returns the snapshot's constraints in insertion order.
func (sn *Snapshot) Constraints() []Constraint { return listCons(sn.cons, sn.order) }

// Solve decides feasibility of the snapshot without caching.
func (sn *Snapshot) Solve() Certificate { return solve(sn.cons, sn.order) }

// Verify checks a certificate against the snapshot's constraints.
func (sn *Snapshot) Verify(cert Certificate) error { return Verify(sn.cons, cert) }

// Verify checks a certificate against the system's current constraints.
func (s *System) Verify(cert Certificate) error { return Verify(s.cons, cert) }

// Verify independently checks that cert is a valid certificate for the
// given constraint set. It shares no state or code with the solver.
func Verify(cons map[int]Constraint, cert Certificate) error {
	switch c := cert.(type) {
	case *Feasible:
		vars := make(map[int]bool)
		for _, k := range cons {
			vars[k.X] = true
			vars[k.Y] = true
		}
		for v := range vars {
			if _, ok := c.Potentials[v]; !ok {
				return fmt.Errorf("feasible certificate missing potential for variable %d", v)
			}
		}
		for _, k := range cons {
			if c.Potentials[k.X]-c.Potentials[k.Y] > k.C {
				return fmt.Errorf("constraint %d violated: %d - %d > %d",
					k.ID, c.Potentials[k.X], c.Potentials[k.Y], k.C)
			}
		}
		return nil
	case *Infeasible:
		if len(c.Cycle) == 0 {
			return errors.New("infeasible certificate has empty cycle")
		}
		seen := make(map[int]bool, len(c.Cycle))
		sum := 0
		for i, id := range c.Cycle {
			k, ok := cons[id]
			if !ok {
				return fmt.Errorf("cycle references unknown constraint %d", id)
			}
			if seen[id] {
				return fmt.Errorf("cycle repeats constraint %d", id)
			}
			seen[id] = true
			next := cons[c.Cycle[(i+1)%len(c.Cycle)]]
			if k.Y != next.X {
				return fmt.Errorf("cycle broken between constraints %d and %d", id, next.ID)
			}
			sum += k.C
		}
		if sum >= 0 {
			return fmt.Errorf("cycle weight %d is not negative", sum)
		}
		return nil
	default:
		return errors.New("unknown certificate type")
	}
}

// solve runs Bellman-Ford from an implicit super-source connected to
// every variable with a zero-weight edge. Edges are relaxed in
// insertion order so results are deterministic.
func solve(cons map[int]Constraint, order []int) Certificate {
	vars := make(map[int]bool)
	for _, k := range cons {
		vars[k.X] = true
		vars[k.Y] = true
	}
	n := len(vars)
	dist := make(map[int]int, n) // super-source edges are zero: start at 0
	pred := make(map[int]int, n) // variable -> constraint ID that relaxed it

	relaxed := -1
	for pass := 0; pass <= n; pass++ {
		relaxed = -1
		for _, id := range order {
			k := cons[id]
			if dist[k.X] > dist[k.Y]+k.C {
				dist[k.X] = dist[k.Y] + k.C
				pred[k.X] = id
				relaxed = k.X
			}
		}
		if relaxed == -1 {
			pot := make(map[int]int, n)
			for v := range vars {
				pot[v] = dist[v]
			}
			return &Feasible{Potentials: pot}
		}
	}

	// A relaxation on pass n proves a negative cycle. Walking
	// predecessors n times lands on the cycle; one more lap collects it.
	v := relaxed
	for i := 0; i < n; i++ {
		v = cons[pred[v]].Y
	}
	start := v
	var cycle []int
	for {
		id := pred[v]
		cycle = append(cycle, id)
		v = cons[id].Y
		if v == start {
			break
		}
	}
	return &Infeasible{Cycle: cycle}
}

func cloneCons(cons map[int]Constraint) map[int]Constraint {
	out := make(map[int]Constraint, len(cons))
	for id, c := range cons {
		out[id] = c
	}
	return out
}

func listCons(cons map[int]Constraint, order []int) []Constraint {
	out := make([]Constraint, 0, len(cons))
	seen := make(map[int]bool, len(order))
	for _, id := range order {
		if c, ok := cons[id]; ok {
			out = append(out, c)
			seen[id] = true
		}
	}
	// Defensive: include anything missing from order, sorted by ID.
	var rest []int
	for id := range cons {
		if !seen[id] {
			rest = append(rest, id)
		}
	}
	sort.Ints(rest)
	for _, id := range rest {
		out = append(out, cons[id])
	}
	return out
}
