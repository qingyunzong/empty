package robocalib

import (
	"errors"
	"testing"
)

func mustAdd(t *testing.T, c *Calibrator, k Constraint) {
	t.Helper()
	if err := c.Add(k); err != nil {
		t.Fatalf("Add(%+v) failed: %v", k, err)
	}
}

func TestChainRelative(t *testing.T) {
	c := New()
	// pose(2) = T12 ∘ pose(1), pose(3) = T23 ∘ pose(2).
	t12 := NewTransform(1, 5, 0)
	t23 := NewTransform(0, 0, 7)
	mustAdd(t, c, Constraint{ID: 12, From: 1, To: 2, T: t12})
	mustAdd(t, c, Constraint{ID: 23, From: 2, To: 3, T: t23})

	snap, ok := c.Snapshot(c.Version())
	if !ok {
		t.Fatal("missing current snapshot")
	}
	rel, ok := snap.Relative(1, 3)
	if !ok {
		t.Fatal("1 and 3 must be connected")
	}
	want := t23.Compose(t12)
	if !rel.Equal(want) {
		t.Fatalf("Relative(1,3) = %v, want %v", rel, want)
	}
	back, ok := snap.Relative(3, 1)
	if !ok || !back.Equal(want.Inverse()) {
		t.Fatalf("Relative(3,1) = %v, want %v", back, want.Inverse())
	}
	if origin, _ := snap.Origin(3); origin != 1 {
		t.Fatalf("origin = %d, want minimum ID 1", origin)
	}
	if pose, _ := snap.Pose(1); !pose.IsIdentity() {
		t.Fatalf("origin pose = %v, want identity", pose)
	}
}

func TestOriginIsMinimumID(t *testing.T) {
	c := New()
	// Insert larger IDs first; the origin must move down as smaller IDs join.
	mustAdd(t, c, Constraint{ID: 1, From: 7, To: 9, T: NewTransform(0, 1, 1)})
	if o, _ := c.versions[c.Version()].Origin(9); o != 7 {
		t.Fatalf("origin = %d, want 7", o)
	}
	mustAdd(t, c, Constraint{ID: 2, From: 3, To: 7, T: NewTransform(2, 4, -1)})
	snap := c.versions[c.Version()]
	if o, _ := snap.Origin(9); o != 3 {
		t.Fatalf("origin after rebase = %d, want 3", o)
	}
	// Potentials must stay consistent across the rebase.
	rel, _ := snap.Relative(3, 9)
	want := NewTransform(0, 1, 1).Compose(NewTransform(2, 4, -1))
	if !rel.Equal(want) {
		t.Fatalf("Relative(3,9) = %v, want %v", rel, want)
	}
	// Merging two components keeps the smaller origin.
	mustAdd(t, c, Constraint{ID: 3, From: 20, To: 21, T: NewTransform(1, 0, 0)})
	mustAdd(t, c, Constraint{ID: 4, From: 9, To: 20, T: NewTransform(3, 2, 2)})
	snap = c.versions[c.Version()]
	for _, robot := range []int{3, 7, 9, 20, 21} {
		if o, _ := snap.Origin(robot); o != 3 {
			t.Fatalf("origin of %d = %d, want 3", robot, o)
		}
	}
}

func TestConflictCertificate(t *testing.T) {
	c := New()
	t12 := NewTransform(1, 5, 0)
	t23 := NewTransform(0, 0, 7)
	mustAdd(t, c, Constraint{ID: 12, From: 1, To: 2, T: t12})
	mustAdd(t, c, Constraint{ID: 23, From: 2, To: 3, T: t23})

	// A closing edge consistent with the chain is accepted.
	consistent := t23.Compose(t12)
	mustAdd(t, c, Constraint{ID: 13, From: 1, To: 3, T: consistent})

	// A contradicting edge is rejected with a loop certificate.
	bad := Constraint{ID: 99, From: 3, To: 1, T: NewTransform(0, 1, 0)}
	err := c.Add(bad)
	var conflict *Conflict
	if !errors.As(err, &conflict) {
		t.Fatalf("expected *Conflict, got %v", err)
	}
	if len(conflict.Cycle) < 2 || conflict.Cycle[0] != 99 {
		t.Fatalf("cycle %v must start with the rejected ID 99", conflict.Cycle)
	}
	if conflict.Composite.IsIdentity() {
		t.Fatal("composite of an inconsistent loop must not be identity")
	}
	// Independently recompute the loop product from the stored constraints.
	byID := map[int]Constraint{12: {ID: 12, From: 1, To: 2, T: t12},
		23: {ID: 23, From: 2, To: 3, T: t23}, 13: {ID: 13, From: 1, To: 3, T: consistent}}
	_ = byID
	// Loop: 3 --99--> 1 --12--> 2 --23--> 3 (or the reverse orientation).
	loop := t23.Compose(t12).Compose(bad.T)
	if !conflict.Composite.Equal(loop) && !conflict.Composite.Equal(loop.Inverse()) {
		t.Fatalf("certificate composite %v matches neither loop product %v nor its inverse",
			conflict.Composite, loop)
	}
	// The calibrator state must be unchanged by the rejection.
	if got := len(c.versions[c.Version()].Constraints()); got != 3 {
		t.Fatalf("constraint count after rejection = %d, want 3", got)
	}
}

func TestSelfLoopConflict(t *testing.T) {
	c := New()
	mustAdd(t, c, Constraint{ID: 1, From: 5, To: 6, T: NewTransform(0, 1, 0)})
	err := c.Add(Constraint{ID: 2, From: 5, To: 5, T: NewTransform(1, 0, 0)})
	var conflict *Conflict
	if !errors.As(err, &conflict) {
		t.Fatalf("expected *Conflict, got %v", err)
	}
	if len(conflict.Cycle) != 1 || conflict.Cycle[0] != 2 {
		t.Fatalf("self-loop cycle = %v, want [2]", conflict.Cycle)
	}
	// An identity self-loop is harmless and accepted.
	mustAdd(t, c, Constraint{ID: 3, From: 5, To: 5, T: Identity()})
}

func TestDuplicateIDRejected(t *testing.T) {
	c := New()
	mustAdd(t, c, Constraint{ID: 1, From: 1, To: 2, T: Identity()})
	if err := c.Add(Constraint{ID: 1, From: 3, To: 4, T: Identity()}); err == nil {
		t.Fatal("duplicate ID must be rejected")
	}
}

func TestSnapshotsSurviveMutation(t *testing.T) {
	c := New()
	mustAdd(t, c, Constraint{ID: 1, From: 1, To: 2, T: NewTransform(0, 3, 0)})
	mustAdd(t, c, Constraint{ID: 2, From: 2, To: 3, T: NewTransform(1, 0, 4)})
	v2 := c.Version()
	if !c.Remove(1) {
		t.Fatal("Remove(1) must succeed")
	}
	if c.Remove(1) {
		t.Fatal("second Remove(1) must fail")
	}
	if c.Remove(404) {
		t.Fatal("Remove of unknown ID must fail")
	}

	old, ok := c.Snapshot(v2)
	if !ok {
		t.Fatalf("snapshot %d lost", v2)
	}
	if got := len(old.Constraints()); got != 2 {
		t.Fatalf("old snapshot holds %d constraints, want 2", got)
	}
	if _, ok := old.Relative(1, 3); !ok {
		t.Fatal("old snapshot: 1 and 3 must still be connected")
	}
	cur := c.versions[c.Version()]
	if _, ok := cur.Relative(1, 3); ok {
		t.Fatal("current snapshot: 1 and 3 must be disconnected after Remove")
	}
	if _, ok := cur.Pose(1); ok {
		t.Fatal("robot 1 must be untracked after its only constraint was removed")
	}
	// Mutating the calibrator further must not touch the old snapshot.
	mustAdd(t, c, Constraint{ID: 7, From: 3, To: 4, T: NewTransform(2, 1, 1)})
	if got := len(old.Constraints()); got != 2 {
		t.Fatalf("old snapshot mutated: %d constraints", got)
	}
}
