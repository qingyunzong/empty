package rolelib

import (
	"errors"
	"reflect"
	"testing"
)

func mustAddEdge(t *testing.T, l *Library, child, parent string) {
	t.Helper()
	if err := l.AddInheritance(child, parent); err != nil {
		t.Fatalf("AddInheritance(%s, %s): %v", child, parent, err)
	}
}

func TestInheritanceTransitive(t *testing.T) {
	l := New()
	mustAddEdge(t, l, "A", "B")
	mustAddEdge(t, l, "B", "C")
	if err := l.Grant("u", "A"); err != nil {
		t.Fatal(err)
	}
	want := []string{"A", "B", "C"}
	if got := l.EffectiveRoles("u"); !reflect.DeepEqual(got, want) {
		t.Fatalf("EffectiveRoles = %v, want %v", got, want)
	}
}

func TestSSDDirectConflict(t *testing.T) {
	l := New()
	if err := l.AddSSD("X", "Y"); err != nil {
		t.Fatal(err)
	}
	if err := l.Grant("u", "X"); err != nil {
		t.Fatal(err)
	}
	err := l.Grant("u", "Y")
	var ce *ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected ConflictError, got %v", err)
	}
	if ce.Conflict.Kind != SSD {
		t.Fatalf("kind = %v, want SSD", ce.Conflict.Kind)
	}
	if got := l.EffectiveRoles("u"); !reflect.DeepEqual(got, []string{"X"}) {
		t.Fatalf("EffectiveRoles = %v, want [X]", got)
	}
}

func TestSSDIndirectConflictChain(t *testing.T) {
	l := New()
	mustAddEdge(t, l, "M", "X") // M inherits X
	if err := l.AddSSD("X", "Y"); err != nil {
		t.Fatal(err)
	}
	if err := l.Grant("u", "M"); err != nil {
		t.Fatal(err)
	}
	err := l.Grant("u", "Y")
	var ce *ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected ConflictError, got %v", err)
	}
	c := ce.Conflict
	if c.Kind != SSD || c.RoleA != "X" || c.RoleB != "Y" {
		t.Fatalf("unexpected conflict: %+v", c)
	}
	if !reflect.DeepEqual(c.ChainA, []string{"M", "X"}) {
		t.Fatalf("ChainA = %v, want [M X]", c.ChainA)
	}
	if !reflect.DeepEqual(c.ChainB, []string{"Y"}) {
		t.Fatalf("ChainB = %v, want [Y]", c.ChainB)
	}
}

func TestShortestChainSelected(t *testing.T) {
	l := New()
	// Two inheritance paths to X: M -> X (length 1) and N -> P -> X (length 2).
	mustAddEdge(t, l, "M", "X")
	mustAddEdge(t, l, "N", "P")
	mustAddEdge(t, l, "P", "X")
	if err := l.AddSSD("X", "Y"); err != nil {
		t.Fatal(err)
	}
	if err := l.GrantBatch("u", "N", "M"); err != nil {
		t.Fatal(err)
	}
	err := l.Grant("u", "Y")
	var ce *ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected ConflictError, got %v", err)
	}
	if !reflect.DeepEqual(ce.Conflict.ChainA, []string{"M", "X"}) {
		t.Fatalf("ChainA = %v, want shortest [M X]", ce.Conflict.ChainA)
	}
}

func TestGrantBatchAtomic(t *testing.T) {
	l := New()
	if err := l.AddSSD("X", "Y"); err != nil {
		t.Fatal(err)
	}
	if err := l.Grant("u", "X"); err != nil {
		t.Fatal(err)
	}
	// Batch conflicts with existing grant: nothing may be granted.
	if err := l.GrantBatch("u", "Z", "Y"); err == nil {
		t.Fatal("expected conflict")
	}
	if got := l.EffectiveRoles("u"); !reflect.DeepEqual(got, []string{"X"}) {
		t.Fatalf("EffectiveRoles = %v, want [X] (batch must be atomic)", got)
	}
	// Batch conflicting internally on a fresh user: nothing may be granted.
	if err := l.GrantBatch("v", "X", "Y"); err == nil {
		t.Fatal("expected conflict")
	}
	if got := l.EffectiveRoles("v"); len(got) != 0 {
		t.Fatalf("EffectiveRoles = %v, want empty (batch must be atomic)", got)
	}
}

func TestDSDSeparateFromSSD(t *testing.T) {
	l := New()
	if err := l.AddDSD("X", "Y"); err != nil {
		t.Fatal(err)
	}
	// DSD does not restrict holding.
	if err := l.GrantBatch("u", "X", "Y"); err != nil {
		t.Fatal(err)
	}
	s := l.OpenSession("u")
	if err := l.Activate(s, "X"); err != nil {
		t.Fatal(err)
	}
	err := l.Activate(s, "Y")
	var ce *ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected ConflictError, got %v", err)
	}
	if ce.Conflict.Kind != DSD {
		t.Fatalf("kind = %v, want DSD", ce.Conflict.Kind)
	}
	// After deactivating X, activating Y succeeds.
	if err := l.Deactivate(s, "X"); err != nil {
		t.Fatal(err)
	}
	if err := l.Activate(s, "Y"); err != nil {
		t.Fatal(err)
	}
	got, _ := l.SessionRoles(s)
	if !reflect.DeepEqual(got, []string{"Y"}) {
		t.Fatalf("SessionRoles = %v, want [Y]", got)
	}
}

func TestDSDIndirectConflictChain(t *testing.T) {
	l := New()
	mustAddEdge(t, l, "M", "X")
	if err := l.AddDSD("X", "Y"); err != nil {
		t.Fatal(err)
	}
	if err := l.GrantBatch("u", "M", "Y"); err != nil {
		t.Fatal(err)
	}
	s := l.OpenSession("u")
	if err := l.Activate(s, "M"); err != nil {
		t.Fatal(err)
	}
	err := l.Activate(s, "Y")
	var ce *ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected ConflictError, got %v", err)
	}
	c := ce.Conflict
	if c.Kind != DSD || !reflect.DeepEqual(c.ChainA, []string{"M", "X"}) || !reflect.DeepEqual(c.ChainB, []string{"Y"}) {
		t.Fatalf("unexpected conflict: %+v", c)
	}
	got, _ := l.SessionRoles(s)
	if !reflect.DeepEqual(got, []string{"M", "X"}) {
		t.Fatalf("SessionRoles = %v, want [M X]", got)
	}
}

func TestCycleDetection(t *testing.T) {
	l := New()
	mustAddEdge(t, l, "A", "B")
	mustAddEdge(t, l, "B", "C")
	var cyc *CycleError
	if err := l.AddInheritance("C", "A"); !errors.As(err, &cyc) {
		t.Fatalf("expected CycleError, got %v", err)
	}
	if err := l.AddInheritance("A", "A"); !errors.As(err, &cyc) {
		t.Fatalf("expected CycleError for self edge, got %v", err)
	}
	// Graph unchanged: D -> A is still fine.
	mustAddEdge(t, l, "D", "A")
}

func TestAddInheritanceCreatingConflictRejected(t *testing.T) {
	l := New()
	if err := l.AddSSD("X", "Y"); err != nil {
		t.Fatal(err)
	}
	if err := l.GrantBatch("u", "M", "Y"); err != nil {
		t.Fatal(err)
	}
	// Making M inherit X would make u hold X and Y: must be rejected.
	err := l.AddInheritance("M", "X")
	var ce *ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected ConflictError, got %v", err)
	}
	if !reflect.DeepEqual(ce.Conflict.ChainA, []string{"M", "X"}) {
		t.Fatalf("ChainA = %v, want [M X]", ce.Conflict.ChainA)
	}
	if got := l.EffectiveRoles("u"); !reflect.DeepEqual(got, []string{"M", "Y"}) {
		t.Fatalf("EffectiveRoles = %v, want [M Y] (edge must be rolled back)", got)
	}
}

func TestAddConstraintWhenViolatedRejected(t *testing.T) {
	l := New()
	if err := l.GrantBatch("u", "X", "Y"); err != nil {
		t.Fatal(err)
	}
	if err := l.AddSSD("X", "Y"); err == nil {
		t.Fatal("expected AddSSD to be rejected")
	}
	// Constraint was rolled back: after revoking Y it can be added.
	l.Revoke("u", "Y")
	if err := l.AddSSD("X", "Y"); err != nil {
		t.Fatal(err)
	}
	// Same for DSD against an active session.
	l2 := New()
	if err := l2.GrantBatch("u", "X", "Y"); err != nil {
		t.Fatal(err)
	}
	s := l2.OpenSession("u")
	if err := l2.Activate(s, "X"); err != nil {
		t.Fatal(err)
	}
	if err := l2.Activate(s, "Y"); err != nil {
		t.Fatal(err)
	}
	if err := l2.AddDSD("X", "Y"); err == nil {
		t.Fatal("expected AddDSD to be rejected")
	}
	if err := l2.Deactivate(s, "Y"); err != nil {
		t.Fatal(err)
	}
	if err := l2.AddDSD("X", "Y"); err != nil {
		t.Fatal(err)
	}
}

func TestRevokePrunesSession(t *testing.T) {
	l := New()
	mustAddEdge(t, l, "M", "X")
	if err := l.Grant("u", "M"); err != nil {
		t.Fatal(err)
	}
	s := l.OpenSession("u")
	if err := l.Activate(s, "X"); err != nil {
		t.Fatal(err)
	}
	l.Revoke("u", "M")
	got, _ := l.SessionRoles(s)
	if len(got) != 0 {
		t.Fatalf("SessionRoles = %v, want empty after revoke", got)
	}
}

func TestRemoveInheritance(t *testing.T) {
	l := New()
	mustAddEdge(t, l, "M", "X")
	if err := l.Grant("u", "M"); err != nil {
		t.Fatal(err)
	}
	s := l.OpenSession("u")
	if err := l.Activate(s, "X"); err != nil {
		t.Fatal(err)
	}
	l.RemoveInheritance("M", "X")
	if got := l.EffectiveRoles("u"); !reflect.DeepEqual(got, []string{"M"}) {
		t.Fatalf("EffectiveRoles = %v, want [M]", got)
	}
	got, _ := l.SessionRoles(s)
	if len(got) != 0 {
		t.Fatalf("SessionRoles = %v, want empty (X no longer held)", got)
	}
}

func TestActivateNotGranted(t *testing.T) {
	l := New()
	s := l.OpenSession("u")
	if err := l.Activate(s, "X"); !errors.Is(err, ErrNotGranted) {
		t.Fatalf("expected ErrNotGranted, got %v", err)
	}
	if _, err := l.SessionRoles(999); !errors.Is(err, ErrUnknownSession) {
		t.Fatalf("expected ErrUnknownSession, got %v", err)
	}
}

func TestSelfExclusionRejected(t *testing.T) {
	l := New()
	if err := l.AddSSD("X", "X"); !errors.Is(err, ErrSelfExclusion) {
		t.Fatalf("expected ErrSelfExclusion, got %v", err)
	}
	if err := l.AddDSD("X", "X"); !errors.Is(err, ErrSelfExclusion) {
		t.Fatalf("expected ErrSelfExclusion, got %v", err)
	}
}
