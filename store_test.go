package objstore

import (
	"bytes"
	"errors"
	"testing"
	"time"
)

// fakeClock is a manually advanced clock for deterministic lease tests.
type fakeClock struct {
	t time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{t: time.Unix(1_700_000_000, 0)} }

func (c *fakeClock) now() time.Time { return c.t }

func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func openTestStore(t *testing.T, dir string, clk *fakeClock, hooks Hooks) *Store {
	t.Helper()
	s, err := Open(dir, &Options{MinAge: time.Minute, Hooks: hooks, Now: clk.now})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestPutGetAndTreeRefs(t *testing.T) {
	clk := newFakeClock()
	s := openTestStore(t, t.TempDir(), clk, Hooks{})

	leaf, err := s.Put([]byte("leaf-data"), nil)
	if err != nil {
		t.Fatalf("Put leaf: %v", err)
	}
	mid, err := s.Put([]byte("mid-data"), []ID{leaf})
	if err != nil {
		t.Fatalf("Put mid: %v", err)
	}
	top, err := s.Put([]byte("top-data"), []ID{mid})
	if err != nil {
		t.Fatalf("Put top: %v", err)
	}

	obj, err := s.Get(top)
	if err != nil {
		t.Fatalf("Get top: %v", err)
	}
	if !bytes.Equal(obj.Data, []byte("top-data")) {
		t.Fatalf("data mismatch: %q", obj.Data)
	}
	if len(obj.Refs) != 1 || obj.Refs[0] != mid {
		t.Fatalf("refs mismatch: %v", obj.Refs)
	}

	missing := ID("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	if _, err := s.Put([]byte("dangling"), []ID{missing}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for dangling ref, got %v", err)
	}
	if _, err := s.Get(missing); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for missing object, got %v", err)
	}
}

func TestUnreachableCollectedWithEvidence(t *testing.T) {
	clk := newFakeClock()
	s := openTestStore(t, t.TempDir(), clk, Hooks{})

	leaf, _ := s.Put([]byte("leaf"), nil)
	top, _ := s.Put([]byte("top"), []ID{leaf})
	if err := s.SetRoot("v1", top); err != nil {
		t.Fatalf("SetRoot: %v", err)
	}
	garbage, err := s.Put([]byte("garbage"), nil)
	if err != nil {
		t.Fatalf("Put garbage: %v", err)
	}

	clk.advance(2 * time.Minute) // expire temp leases

	evs, err := s.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(evs) != 1 {
		t.Fatalf("expected exactly 1 deletion, got %d: %+v", len(evs), evs)
	}
	ev := evs[0]
	if ev.Object != garbage {
		t.Fatalf("deleted wrong object: %s", ev.Object)
	}
	if ev.Cycle != 1 {
		t.Fatalf("evidence cycle = %d, want 1", ev.Cycle)
	}
	if ev.RootGeneration != s.RootGeneration() {
		t.Fatalf("evidence root generation = %d, want %d", ev.RootGeneration, s.RootGeneration())
	}
	if ev.Roots["v1"] != top {
		t.Fatalf("evidence root snapshot wrong: %v", ev.Roots)
	}
	if ev.Reason == "" {
		t.Fatal("evidence missing reason")
	}
	if ev.Marked != 2 {
		t.Fatalf("evidence marked = %d, want 2 (top+leaf)", ev.Marked)
	}
	if s.Has(garbage) {
		t.Fatal("garbage object still present after GC")
	}
	if !s.Has(top) || !s.Has(leaf) {
		t.Fatal("reachable tree was deleted")
	}
}

func TestTempUploadLeaseProtectsYoungObjects(t *testing.T) {
	clk := newFakeClock()
	s := openTestStore(t, t.TempDir(), clk, Hooks{})

	up := s.BeginUpload()
	up.Write([]byte("temp-data"))
	id, err := up.Commit()
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// Within the lease the unreferenced object survives GC.
	evs, err := s.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(evs) != 0 {
		t.Fatalf("young temp upload collected: %+v", evs)
	}
	if !s.Has(id) {
		t.Fatal("temp upload missing after GC within lease")
	}

	// After the lease expires it becomes collectable.
	clk.advance(2 * time.Minute)
	evs, err = s.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(evs) != 1 || evs[0].Object != id {
		t.Fatalf("expected expired temp upload collected, got %+v", evs)
	}
	if s.Has(id) {
		t.Fatal("expired temp upload still present")
	}
}

func TestDeleteRootReleasesTree(t *testing.T) {
	clk := newFakeClock()
	s := openTestStore(t, t.TempDir(), clk, Hooks{})

	leaf, _ := s.Put([]byte("leaf"), nil)
	top, _ := s.Put([]byte("top"), []ID{leaf})
	s.SetRoot("v1", top)
	clk.advance(2 * time.Minute)

	if err := s.DeleteRoot("v1"); err != nil {
		t.Fatalf("DeleteRoot: %v", err)
	}
	evs, err := s.Collect()
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(evs) != 2 {
		t.Fatalf("expected whole tree collected, got %+v", evs)
	}
	if s.Has(top) || s.Has(leaf) {
		t.Fatal("unrooted tree survived GC")
	}
	if err := s.DeleteRoot("v1"); err != nil {
		t.Fatalf("DeleteRoot of missing root should be a no-op: %v", err)
	}
}
