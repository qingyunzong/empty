package blockstore

import (
	"errors"
	"testing"
)

func mustTree(t *testing.T, s *Store, children []Hash) Hash {
	t.Helper()
	h, err := s.PutTree(children)
	if err != nil {
		t.Fatalf("PutTree: %v", err)
	}
	return h
}

func TestLeafDedup(t *testing.T) {
	s := New()
	a := s.PutLeaf([]byte("hello"))
	b := s.PutLeaf([]byte("hello"))
	c := s.PutLeaf([]byte("world"))
	if a != b {
		t.Fatal("identical content must dedup to the same hash")
	}
	if a == c {
		t.Fatal("different content must hash differently")
	}
	if s.BlockCount() != 2 {
		t.Fatalf("want 2 blocks, got %d", s.BlockCount())
	}
}

func TestTreeDedup(t *testing.T) {
	s := New()
	leaf := s.PutLeaf([]byte("x"))
	t1 := mustTree(t, s, []Hash{leaf})
	t2 := mustTree(t, s, []Hash{leaf})
	if t1 != t2 {
		t.Fatal("identical child lists must dedup to the same tree hash")
	}
	if s.BlockCount() != 2 {
		t.Fatalf("want 2 blocks, got %d", s.BlockCount())
	}
}

func TestPutTreeMissingChild(t *testing.T) {
	s := New()
	if _, err := s.PutTree([]Hash{{1, 2, 3}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

// Two roots share a subtree; removing one root must keep the shared
// sub-blocks alive, and removing the second must free everything.
func TestSharedSubBlocksNotFreedEarly(t *testing.T) {
	s := New()
	shared := s.PutLeaf([]byte("shared"))
	sub := mustTree(t, s, []Hash{shared})
	rootA := mustTree(t, s, []Hash{sub})
	rootB := mustTree(t, s, []Hash{sub, s.PutLeaf([]byte("b-only"))})

	if err := s.AddRoot(rootA); err != nil {
		t.Fatal(err)
	}
	if err := s.AddRoot(rootB); err != nil {
		t.Fatal(err)
	}
	if got := s.Refs(shared); got != 2 {
		t.Fatalf("shared leaf refs: want 2, got %d", got)
	}
	if got := s.Refs(sub); got != 2 {
		t.Fatalf("shared subtree refs: want 2, got %d", got)
	}

	if err := s.RemoveRoot(rootA); err != nil {
		t.Fatal(err)
	}
	if !s.Has(shared) || !s.Has(sub) {
		t.Fatal("shared sub-blocks must survive removal of one root")
	}
	if got := s.Refs(shared); got != 1 {
		t.Fatalf("shared leaf refs after first removal: want 1, got %d", got)
	}
	if err := s.Verify(); err != nil {
		t.Fatalf("Verify after first removal: %v", err)
	}

	if err := s.RemoveRoot(rootB); err != nil {
		t.Fatal(err)
	}
	if s.BlockCount() != 0 {
		t.Fatalf("all blocks must be freed, %d remain", s.BlockCount())
	}
	if err := s.Verify(); err != nil {
		t.Fatalf("Verify on empty store: %v", err)
	}
}

// Diamond: root -> {left, right}, left -> shared, right -> shared.
// Removing the root must decrement the shared block exactly once.
func TestDiamondNoDoubleFree(t *testing.T) {
	s := New()
	shared := s.PutLeaf([]byte("shared"))
	left := mustTree(t, s, []Hash{shared})
	right := mustTree(t, s, []Hash{shared})
	root := mustTree(t, s, []Hash{left, right})

	if err := s.AddRoot(root); err != nil {
		t.Fatal(err)
	}
	if got := s.Refs(shared); got != 1 {
		t.Fatalf("diamond shared leaf refs: want 1 (per-root), got %d", got)
	}
	if err := s.RemoveRoot(root); err != nil {
		t.Fatal(err)
	}
	if s.BlockCount() != 0 {
		t.Fatalf("diamond teardown must free all blocks, %d remain", s.BlockCount())
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestRemoveRootNotRoot(t *testing.T) {
	s := New()
	h := s.PutLeaf([]byte("x"))
	if err := s.RemoveRoot(h); !errors.Is(err, ErrNotRoot) {
		t.Fatalf("want ErrNotRoot, got %v", err)
	}
}

func TestRootMultiplicity(t *testing.T) {
	s := New()
	h := s.PutLeaf([]byte("x"))
	if err := s.AddRoot(h); err != nil {
		t.Fatal(err)
	}
	if err := s.AddRoot(h); err != nil {
		t.Fatal(err)
	}
	if got := s.Refs(h); got != 2 {
		t.Fatalf("want refs 2, got %d", got)
	}
	if err := s.RemoveRoot(h); err != nil {
		t.Fatal(err)
	}
	if !s.Has(h) {
		t.Fatal("block must survive while one root reference remains")
	}
	if err := s.RemoveRoot(h); err != nil {
		t.Fatal(err)
	}
	if s.Has(h) {
		t.Fatal("block must be freed after last root reference removed")
	}
}

func TestTxCommit(t *testing.T) {
	s := New()
	tx := s.Begin()
	leaf := tx.PutLeaf([]byte("tx-data"))
	root, err := tx.PutTree([]Hash{leaf})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.AddRoot(root); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if got := s.Refs(root); got != 1 {
		t.Fatalf("root refs: want 1, got %d", got)
	}
	if got := s.Refs(leaf); got != 1 {
		t.Fatalf("leaf refs: want 1, got %d", got)
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}

// A failed AddRoot must roll back the whole transaction: staged
// blocks disappear and pre-existing state is untouched.
func TestTxAddRootFailureRollsBack(t *testing.T) {
	s := New()
	existing := s.PutLeaf([]byte("pre-existing"))
	if err := s.AddRoot(existing); err != nil {
		t.Fatal(err)
	}

	tx := s.Begin()
	staged := tx.PutLeaf([]byte("staged"))
	if _, err := tx.PutTree([]Hash{staged}); err != nil {
		t.Fatal(err)
	}
	var missing Hash
	missing[0] = 0xff
	if err := tx.AddRoot(missing); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}

	if s.Has(staged) {
		t.Fatal("staged block must be rolled back after AddRoot failure")
	}
	if s.BlockCount() != 1 {
		t.Fatalf("only the pre-existing block must remain, got %d", s.BlockCount())
	}
	if got := s.Refs(existing); got != 1 {
		t.Fatalf("pre-existing refs: want 1, got %d", got)
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}

// A failed PutTree (missing child) must also roll back everything.
func TestTxPutTreeFailureRollsBack(t *testing.T) {
	s := New()
	tx := s.Begin()
	staged := tx.PutLeaf([]byte("staged"))
	var missing Hash
	missing[0] = 0xee
	if _, err := tx.PutTree([]Hash{missing}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
	if s.Has(staged) {
		t.Fatal("staged block must be rolled back after PutTree failure")
	}
	if s.BlockCount() != 0 {
		t.Fatalf("store must be empty, got %d blocks", s.BlockCount())
	}
}

func TestTxExplicitRollback(t *testing.T) {
	s := New()
	tx := s.Begin()
	leaf := tx.PutLeaf([]byte("x"))
	root, err := tx.PutTree([]Hash{leaf})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.AddRoot(root); err != nil {
		t.Fatal(err)
	}
	tx.Rollback()
	if s.BlockCount() != 0 || s.RootCount() != 0 {
		t.Fatalf("rollback must restore empty store: blocks=%d roots=%d", s.BlockCount(), s.RootCount())
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}

// Cyclic input staged via raw import must be rejected at Commit and
// fully rolled back.
func TestCycleRejected(t *testing.T) {
	s := New()
	var ha, hb Hash
	ha[0] = 0xa0
	hb[0] = 0xb0

	tx := s.Begin()
	if err := tx.PutTreeRaw(ha, []Hash{hb}); err != nil {
		t.Fatal(err)
	}
	if err := tx.PutTreeRaw(hb, []Hash{ha}); err != nil {
		t.Fatal(err)
	}
	if err := tx.AddRoot(ha); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); !errors.Is(err, ErrCycle) {
		t.Fatalf("want ErrCycle, got %v", err)
	}
	if s.BlockCount() != 0 || s.RootCount() != 0 {
		t.Fatalf("rejected cycle must leave store empty: blocks=%d roots=%d", s.BlockCount(), s.RootCount())
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestSelfCycleRejected(t *testing.T) {
	s := New()
	var h Hash
	h[0] = 0x5e
	tx := s.Begin()
	if err := tx.PutTreeRaw(h, []Hash{h}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); !errors.Is(err, ErrCycle) {
		t.Fatalf("want ErrCycle, got %v", err)
	}
	if s.BlockCount() != 0 {
		t.Fatalf("store must be empty after rejection, got %d blocks", s.BlockCount())
	}
}

func TestDanglingReferenceRejected(t *testing.T) {
	s := New()
	var h, missing Hash
	h[0] = 0xd1
	missing[0] = 0xd2
	tx := s.Begin()
	if err := tx.PutTreeRaw(h, []Hash{missing}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); !errors.Is(err, ErrDangling) {
		t.Fatalf("want ErrDangling, got %v", err)
	}
	if s.BlockCount() != 0 {
		t.Fatalf("store must be empty after rejection, got %d blocks", s.BlockCount())
	}
}

func TestTxUseAfterDone(t *testing.T) {
	s := New()
	tx := s.Begin()
	tx.Rollback()
	if _, err := tx.PutTree(nil); !errors.Is(err, ErrTxDone) {
		t.Fatalf("want ErrTxDone, got %v", err)
	}
	if err := tx.AddRoot(Hash{}); !errors.Is(err, ErrTxDone) {
		t.Fatalf("want ErrTxDone, got %v", err)
	}
	if err := tx.Commit(); !errors.Is(err, ErrTxDone) {
		t.Fatalf("want ErrTxDone, got %v", err)
	}
}

// Verify uses the full reachability scan to confirm liveness matches
// reference counts after a mixed sequence of operations.
func TestVerifyReachabilityModel(t *testing.T) {
	s := New()
	a := s.PutLeaf([]byte("a"))
	b := s.PutLeaf([]byte("b"))
	ab := mustTree(t, s, []Hash{a, b})
	aa := mustTree(t, s, []Hash{a, a})
	top1 := mustTree(t, s, []Hash{ab, aa})
	top2 := mustTree(t, s, []Hash{ab})

	for _, r := range []Hash{top1, top2} {
		if err := s.AddRoot(r); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
	// a is reachable from both roots: refs must be exactly 2 even
	// though three tree edges point at it.
	if got := s.Refs(a); got != 2 {
		t.Fatalf("leaf a refs: want 2, got %d", got)
	}
	if err := s.RemoveRoot(top1); err != nil {
		t.Fatal(err)
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
	if !s.Has(a) || !s.Has(b) || !s.Has(ab) {
		t.Fatal("blocks shared with top2 must survive")
	}
	if s.Has(aa) {
		t.Fatal("aa was only reachable from top1 and must be freed")
	}
	if err := s.RemoveRoot(top2); err != nil {
		t.Fatal(err)
	}
	if s.BlockCount() != 0 {
		t.Fatalf("store must be empty, got %d blocks", s.BlockCount())
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestCollectGarbage(t *testing.T) {
	s := New()
	rooted := s.PutLeaf([]byte("rooted"))
	s.PutLeaf([]byte("garbage-1"))
	g2 := s.PutLeaf([]byte("garbage-2"))
	if _, err := s.PutTree([]Hash{g2}); err != nil {
		t.Fatal(err)
	}
	if err := s.AddRoot(rooted); err != nil {
		t.Fatal(err)
	}
	if freed := s.CollectGarbage(); freed != 3 {
		t.Fatalf("want 3 blocks freed, got %d", freed)
	}
	if s.BlockCount() != 1 || !s.Has(rooted) {
		t.Fatal("only the rooted block must survive GC")
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}
