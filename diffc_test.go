package diffc

import (
	"reflect"
	"strings"
	"testing"
)

func mustSolveFeasible(t *testing.T, snap Snapshot) Certificate {
	t.Helper()
	cert := snap.Solve()
	if !cert.Feasible {
		t.Fatalf("expected feasible, got cycle %v", cert.Cycle)
	}
	if err := snap.Verify(cert); err != nil {
		t.Fatalf("feasible certificate does not verify: %v", err)
	}
	return cert
}

func mustSolveCycle(t *testing.T, snap Snapshot) Certificate {
	t.Helper()
	cert := snap.Solve()
	if cert.Feasible {
		t.Fatalf("expected negative cycle, got potentials %v", cert.Potentials)
	}
	if err := snap.Verify(cert); err != nil {
		t.Fatalf("cycle certificate does not verify: %v", err)
	}
	return cert
}

func TestAddRemoveLen(t *testing.T) {
	s := New()
	id1 := s.Add(1, 2, 5)
	id2 := s.Add(2, 3, -1)
	if s.Len() != 2 {
		t.Fatalf("Len = %d, want 2", s.Len())
	}
	if id1 == id2 {
		t.Fatalf("duplicate IDs %d", id1)
	}
	if !s.Remove(id1) {
		t.Fatal("Remove existing returned false")
	}
	if s.Remove(id1) {
		t.Fatal("Remove missing returned true")
	}
	if s.Len() != 1 {
		t.Fatalf("Len = %d, want 1", s.Len())
	}
}

func TestFeasiblePotentials(t *testing.T) {
	s := New()
	s.Add(1, 2, 4)  // x1 - x2 <= 4
	s.Add(2, 3, 2)  // x2 - x3 <= 2
	s.Add(1, 3, 8)  // x1 - x3 <= 8
	s.Add(3, 1, -3) // x3 - x1 <= -3
	cert := mustSolveFeasible(t, s.Snapshot())
	if len(cert.Potentials) != 3 {
		t.Fatalf("potentials cover %d variables, want 3", len(cert.Potentials))
	}
}

func TestNegativeCycle(t *testing.T) {
	s := New()
	s.Add(1, 2, 1)  // x1 - x2 <= 1
	s.Add(2, 3, 1)  // x2 - x3 <= 1
	s.Add(3, 1, -5) // x3 - x1 <= -5  => cycle weight -3
	cert := mustSolveCycle(t, s.Snapshot())
	if len(cert.Cycle) != 3 {
		t.Fatalf("cycle length = %d, want 3 (%v)", len(cert.Cycle), cert.Cycle)
	}
}

func TestNegativeSelfLoop(t *testing.T) {
	s := New()
	s.Add(1, 1, -1) // x1 - x1 <= -1
	cert := mustSolveCycle(t, s.Snapshot())
	if len(cert.Cycle) != 1 {
		t.Fatalf("cycle = %v, want single self-loop", cert.Cycle)
	}
}

func TestSnapshotStaysReadable(t *testing.T) {
	s := New()
	s.Add(1, 2, 4)
	snap := s.Snapshot()
	before := snap.Solve()

	// Mutate the system heavily; the old snapshot must not change.
	s.Add(2, 1, -100) // makes the live system infeasible
	s.Remove(1)
	s.Undo()
	s.Add(3, 3, -1)

	after := snap.Solve()
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("snapshot changed: before %+v after %+v", before, after)
	}
	if err := snap.Verify(after); err != nil {
		t.Fatalf("old snapshot certificate invalid: %v", err)
	}
	if live := s.Snapshot().Solve(); live.Feasible {
		t.Fatal("live system should be infeasible after mutations")
	}
}

func TestUndoRestoresOldCertificate(t *testing.T) {
	s := New()
	s.Add(1, 2, 4)
	s.Add(2, 3, 2)
	oldCert := s.Snapshot().Solve()

	s.Add(3, 1, -100) // now infeasible
	if cert := s.Snapshot().Solve(); cert.Feasible {
		t.Fatal("expected infeasible after mutation")
	}
	if !s.Undo() {
		t.Fatal("Undo returned false")
	}
	restored := s.Snapshot().Solve()
	if !reflect.DeepEqual(oldCert, restored) {
		t.Fatalf("undo did not restore old certificate:\nold %+v\nnew %+v", oldCert, restored)
	}
	if err := s.Snapshot().Verify(restored); err != nil {
		t.Fatalf("restored certificate invalid: %v", err)
	}
	if s.Undo() && s.Len() != 1 {
		t.Fatalf("after second undo Len = %d, want 1", s.Len())
	}
}

func TestUndoEmpty(t *testing.T) {
	s := New()
	if s.Undo() {
		t.Fatal("Undo on empty history returned true")
	}
}

func TestApplyAtomicFailure(t *testing.T) {
	s := New()
	id1 := s.Add(1, 2, 4)
	before := s.Snapshot()

	_, err := s.Apply(
		Edit{X: 2, Y: 3, C: +1},
		Edit{Remove: true, ID: id1},
		Edit{Remove: true, ID: 999}, // does not exist: whole batch must fail
	)
	if err == nil {
		t.Fatal("expected error for batch with unknown ID")
	}
	after := s.Snapshot()
	if !reflect.DeepEqual(before.Constraints(), after.Constraints()) {
		t.Fatalf("failed batch mutated the system: %v -> %v", before.Constraints(), after.Constraints())
	}

	// Removing the same ID twice must also fail atomically.
	if _, err := s.Apply(Edit{Remove: true, ID: id1}, Edit{Remove: true, ID: id1}); err == nil {
		t.Fatal("expected error for duplicate removal")
	}
	if !reflect.DeepEqual(before.Constraints(), s.Snapshot().Constraints()) {
		t.Fatal("duplicate-removal batch mutated the system")
	}
}

func TestApplyAtomicSuccess(t *testing.T) {
	s := New()
	id1 := s.Add(1, 2, 4)
	ids, err := s.Apply(
		Edit{X: 2, Y: 3, C: 2},
		Edit{Remove: true, ID: id1},
		Edit{X: 3, Y: 1, C: -3},
	)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("got %d new IDs, want 2", len(ids))
	}
	if s.Len() != 2 {
		t.Fatalf("Len = %d, want 2", s.Len())
	}
	mustSolveFeasible(t, s.Snapshot())
	if !s.Undo() {
		t.Fatal("Undo after Apply returned false")
	}
	if s.Len() != 1 {
		t.Fatalf("undo of batch should restore single constraint, got %d", s.Len())
	}
}

func TestVerifyRejectsBadCertificates(t *testing.T) {
	s := New()
	s.Add(1, 2, 4)
	s.Add(2, 1, -2)
	snap := s.Snapshot()

	// Tampered potentials violating x2 - x1 <= -2.
	bad := Certificate{Feasible: true, Potentials: map[int]int64{1: 0, 2: 5}}
	if err := snap.Verify(bad); err == nil {
		t.Fatal("accepted violating potentials")
	}
	// Potentials missing a variable.
	missing := Certificate{Feasible: true, Potentials: map[int]int64{1: 0}}
	if err := snap.Verify(missing); err == nil {
		t.Fatal("accepted incomplete potentials")
	}
	// Unknown constraint ID in cycle.
	if err := snap.Verify(Certificate{Cycle: []int{42}}); err == nil {
		t.Fatal("accepted cycle with unknown ID")
	}
	// Empty cycle.
	if err := snap.Verify(Certificate{Cycle: nil}); err == nil {
		t.Fatal("accepted empty cycle")
	}
}

func TestVerifyRejectsNonNegativeCycle(t *testing.T) {
	s := New()
	a := s.Add(1, 2, 3)
	b := s.Add(2, 1, 1) // cycle weight 4 >= 0
	if err := s.Snapshot().Verify(Certificate{Cycle: []int{a, b}}); err == nil {
		t.Fatal("accepted non-negative cycle")
	}
	if err := s.Snapshot().Verify(Certificate{Cycle: []int{b, a}}); err == nil {
		t.Fatal("accepted non-negative cycle (reversed)")
	}
}

func TestVerifyRejectsBrokenChain(t *testing.T) {
	s := New()
	a := s.Add(1, 2, -5)
	b := s.Add(3, 4, -5) // disjoint edge: cannot chain with a
	err := s.Snapshot().Verify(Certificate{Cycle: []int{a, b}})
	if err == nil || !strings.Contains(err.Error(), "chain") {
		t.Fatalf("expected chaining error, got %v", err)
	}
}
