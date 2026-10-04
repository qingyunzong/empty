package diffconstraints

import (
	"math/rand"
	"reflect"
	"testing"
)

func mustApply(t *testing.T, s *System, adds []Constraint, removes []int) {
	t.Helper()
	if err := s.Apply(adds, removes); err != nil {
		t.Fatalf("Apply(%v, %v): %v", adds, removes, err)
	}
}

func TestFeasibleCertificate(t *testing.T) {
	s := NewSystem()
	mustApply(t, s, []Constraint{
		{ID: 1, X: 1, Y: 2, C: 3},
		{ID: 2, X: 2, Y: 3, C: -1},
		{ID: 3, X: 1, Y: 3, C: 5},
	}, nil)
	cert := s.Solve()
	f, ok := cert.(*Feasible)
	if !ok {
		t.Fatalf("expected feasible, got %#v", cert)
	}
	if err := s.Verify(cert); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	for _, c := range s.Constraints() {
		if f.Potentials[c.X]-f.Potentials[c.Y] > c.C {
			t.Fatalf("constraint %+v violated by %v", c, f.Potentials)
		}
	}
}

func TestInfeasibleCertificate(t *testing.T) {
	s := NewSystem()
	mustApply(t, s, []Constraint{
		{ID: 10, X: 1, Y: 2, C: 1},
		{ID: 11, X: 2, Y: 3, C: 1},
		{ID: 12, X: 3, Y: 1, C: -5},
	}, nil)
	cert := s.Solve()
	inf, ok := cert.(*Infeasible)
	if !ok {
		t.Fatalf("expected infeasible, got %#v", cert)
	}
	if err := s.Verify(cert); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	want := map[int]bool{10: true, 11: true, 12: true}
	if len(inf.Cycle) != 3 {
		t.Fatalf("cycle = %v, want 3 edges", inf.Cycle)
	}
	for _, id := range inf.Cycle {
		if !want[id] {
			t.Fatalf("unexpected constraint %d in cycle %v", id, inf.Cycle)
		}
	}
}

func TestBatchAtomicity(t *testing.T) {
	s := NewSystem()
	mustApply(t, s, []Constraint{{ID: 1, X: 1, Y: 2, C: 0}}, nil)
	before := s.Constraints()

	bad := []struct {
		adds    []Constraint
		removes []int
	}{
		{[]Constraint{{ID: 1, X: 3, Y: 4, C: 0}}, nil},                            // duplicate existing ID
		{[]Constraint{{ID: 2, X: 3, Y: 4, C: 0}, {ID: 2, X: 4, Y: 5, C: 0}}, nil}, // duplicate within batch
		{nil, []int{99}},   // remove unknown ID
		{nil, []int{1, 1}}, // remove same ID twice
		{[]Constraint{{ID: 7, X: 1, Y: 2, C: 0}}, []int{7}}, // add+remove unknown in one batch
	}
	for i, b := range bad {
		if err := s.Apply(b.adds, b.removes); err == nil {
			t.Fatalf("case %d: expected error", i)
		}
		if got := s.Constraints(); !reflect.DeepEqual(got, before) {
			t.Fatalf("case %d: system changed after failed batch: %v", i, got)
		}
	}

	// A valid batch mixing add and remove applies fully.
	mustApply(t, s, []Constraint{{ID: 2, X: 2, Y: 3, C: 4}}, []int{1})
	got := s.Constraints()
	if len(got) != 1 || got[0].ID != 2 {
		t.Fatalf("after valid batch: %v", got)
	}
}

func TestSnapshotReadableAfterMutation(t *testing.T) {
	s := NewSystem()
	mustApply(t, s, []Constraint{
		{ID: 1, X: 1, Y: 2, C: 2},
		{ID: 2, X: 2, Y: 1, C: 2},
	}, nil)
	snap := s.Snapshot()
	snapCert := snap.Solve()
	if err := snap.Verify(snapCert); err != nil {
		t.Fatalf("snapshot verify: %v", err)
	}
	if _, ok := snapCert.(*Feasible); !ok {
		t.Fatalf("snapshot should be feasible, got %#v", snapCert)
	}

	// Make the live system infeasible; the snapshot must be unaffected.
	mustApply(t, s, []Constraint{{ID: 3, X: 1, Y: 1, C: -1}}, nil)
	if _, ok := s.Solve().(*Infeasible); !ok {
		t.Fatalf("live system should be infeasible")
	}
	if _, ok := snap.Solve().(*Feasible); !ok {
		t.Fatalf("snapshot changed after live mutation")
	}
	if got := snap.Constraints(); len(got) != 2 {
		t.Fatalf("snapshot constraints changed: %v", got)
	}
	s.Undo()
	if _, ok := snap.Solve().(*Feasible); !ok {
		t.Fatalf("snapshot changed after undo")
	}
}

func TestUndoRestoresOldCertificate(t *testing.T) {
	s := NewSystem()
	mustApply(t, s, []Constraint{{ID: 1, X: 1, Y: 2, C: 5}}, nil)
	certA := s.Solve()
	if s.Certificate() == nil {
		t.Fatal("Solve did not cache certificate")
	}

	mustApply(t, s, []Constraint{{ID: 2, X: 2, Y: 1, C: -10}}, nil)
	if s.Certificate() != nil {
		t.Fatal("certificate should be invalidated by Apply")
	}
	certB := s.Solve()
	if _, ok := certB.(*Infeasible); !ok {
		t.Fatalf("expected infeasible after batch, got %#v", certB)
	}

	if !s.Undo() {
		t.Fatal("undo failed")
	}
	got := s.Certificate()
	if !reflect.DeepEqual(got, certA) {
		t.Fatalf("undo did not restore old certificate: got %#v want %#v", got, certA)
	}
	if err := s.Verify(got); err != nil {
		t.Fatalf("restored certificate does not verify: %v", err)
	}
	if s.Undo() && s.Certificate() != nil {
		t.Fatal("undo to empty system should restore nil certificate")
	}
	if s.Undo() {
		t.Fatal("undo past empty history")
	}
}

func TestVerifyRejectsBadCertificates(t *testing.T) {
	s := NewSystem()
	mustApply(t, s, []Constraint{
		{ID: 1, X: 1, Y: 2, C: 1},
		{ID: 2, X: 2, Y: 1, C: -3},
		{ID: 3, X: 3, Y: 1, C: 0},
	}, nil)
	bad := []Certificate{
		&Feasible{Potentials: map[int]int{1: 0}},             // missing variables
		&Feasible{Potentials: map[int]int{1: 5, 2: 0, 3: 0}}, // violates constraint 1
		&Infeasible{Cycle: nil},                              // empty cycle
		&Infeasible{Cycle: []int{1, 2, 9}},                   // unknown ID
		&Infeasible{Cycle: []int{1, 1}},                      // repeated ID
		&Infeasible{Cycle: []int{1, 3}},                      // broken chain: 1.Y=2 != 3.X=3
	}
	for i, cert := range bad {
		if err := s.Verify(cert); err == nil {
			t.Fatalf("case %d: bad certificate accepted", i)
		}
	}
	// The real certificate (cycle 1,2 with sum -2) verifies.
	if err := s.Verify(&Infeasible{Cycle: []int{1, 2}}); err != nil {
		t.Fatalf("valid cycle rejected: %v", err)
	}
	// A non-negative cycle must be rejected even if well formed.
	s2 := NewSystem()
	mustApply(t, s2, []Constraint{
		{ID: 1, X: 1, Y: 2, C: 1},
		{ID: 2, X: 2, Y: 1, C: 1},
	}, nil)
	if err := s2.Verify(&Infeasible{Cycle: []int{1, 2}}); err == nil {
		t.Fatal("non-negative cycle accepted as infeasible certificate")
	}
}

// TestSolveMatchesBruteForceModel cross-checks Solve against the
// independent full-path model on many random small graphs, and checks
// every certificate from both sides with the independent verifier.
func TestSolveMatchesBruteForceModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 2000; trial++ {
		n := 1 + rng.Intn(5) // variables 0..n-1
		m := rng.Intn(8)     // constraints
		adds := make([]Constraint, m)
		for i := range adds {
			adds[i] = Constraint{
				ID: i + 1,
				X:  rng.Intn(n),
				Y:  rng.Intn(n),
				C:  rng.Intn(11) - 5,
			}
		}
		s := NewSystem()
		if err := s.Apply(adds, nil); err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		got := s.Solve()
		model := BruteForce(s.Constraints())

		switch g := got.(type) {
		case *Feasible:
			if _, ok := model.(*Feasible); !ok {
				t.Fatalf("trial %d: Solve feasible but model says %#v; cons=%v", trial, model, adds)
			}
		case *Infeasible:
			if _, ok := model.(*Infeasible); !ok {
				t.Fatalf("trial %d: Solve infeasible (cycle %v) but model feasible; cons=%v", trial, g.Cycle, adds)
			}
		}
		if err := s.Verify(got); err != nil {
			t.Fatalf("trial %d: solver certificate fails Verify: %v; cons=%v", trial, err, adds)
		}
		if err := s.Verify(model); err != nil {
			t.Fatalf("trial %d: model certificate fails Verify: %v; cons=%v", trial, err, adds)
		}
	}
}

// TestUndoAcrossRandomHistory ensures snapshots taken mid-history keep
// solving to the same certificate after arbitrary later mutations.
func TestUndoAcrossRandomHistory(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	s := NewSystem()
	type point struct {
		snap *Snapshot
		cert Certificate
	}
	var points []point
	nextID := 1
	for step := 0; step < 60; step++ {
		var adds []Constraint
		for i := 0; i < rng.Intn(3); i++ {
			adds = append(adds, Constraint{
				ID: nextID,
				X:  rng.Intn(4),
				Y:  rng.Intn(4),
				C:  rng.Intn(9) - 4,
			})
			nextID++
		}
		var removes []int
		for _, c := range s.Constraints() {
			if rng.Intn(4) == 0 {
				removes = append(removes, c.ID)
			}
		}
		if err := s.Apply(adds, removes); err != nil {
			t.Fatalf("step %d: %v", step, err)
		}
		snap := s.Snapshot()
		points = append(points, point{snap, snap.Solve()})
	}
	// Undo everything, then confirm every snapshot still solves to the
	// exact certificate it produced when taken.
	for s.Undo() {
	}
	for i, p := range points {
		got := p.snap.Solve()
		if !reflect.DeepEqual(got, p.cert) {
			t.Fatalf("snapshot %d changed: got %#v want %#v", i, got, p.cert)
		}
		if err := p.snap.Verify(got); err != nil {
			t.Fatalf("snapshot %d certificate fails verify: %v", i, err)
		}
	}
}
