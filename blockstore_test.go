package blockstore

import (
	"errors"
	"strings"
	"testing"
)

func leaf(data string) Node { return Node{Data: []byte(data)} }

func mustAdd(t *testing.T, s *Store, nodes ...Node) Hash {
	t.Helper()
	h, err := s.AddRoot(nodes...)
	if err != nil {
		t.Fatalf("AddRoot: %v", err)
	}
	return h
}

func mustVerify(t *testing.T, s *Store) {
	t.Helper()
	if err := s.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

// Identical content is stored once and shared by reference.
func TestContentDedup(t *testing.T) {
	s := New()
	n := leaf("hello")

	h1 := mustAdd(t, s, n)
	h2 := mustAdd(t, s, n)
	if h1 != h2 {
		t.Fatalf("same content produced different hashes: %s vs %s", h1, h2)
	}
	if got := s.BlockCount(); got != 1 {
		t.Fatalf("BlockCount = %d, want 1 (dedup)", got)
	}
	if got := s.RefCount(h1); got != 2 {
		t.Fatalf("RefCount = %d, want 2 (two root pins)", got)
	}
	mustVerify(t, s)

	if err := s.DeleteRoot(h1); err != nil {
		t.Fatal(err)
	}
	if !s.Has(h1) || s.RefCount(h1) != 1 {
		t.Fatalf("block gone or refs=%d after first delete", s.RefCount(h1))
	}
	if err := s.DeleteRoot(h2); err != nil {
		t.Fatal(err)
	}
	if got := s.BlockCount(); got != 0 {
		t.Fatalf("BlockCount = %d, want 0", got)
	}
	mustVerify(t, s)
}

// A sub-block shared by two roots survives the deletion of either one.
func TestSharedSubBlockAcrossRoots(t *testing.T) {
	s := New()
	shared := leaf("shared")
	sh := HashOf(shared)

	rootA := mustAdd(t, s, shared, Node{Data: []byte("A"), Children: []Hash{sh}})
	rootB := mustAdd(t, s, shared, Node{Data: []byte("B"), Children: []Hash{sh}})

	if got := s.BlockCount(); got != 3 {
		t.Fatalf("BlockCount = %d, want 3 (A, B, shared)", got)
	}
	if got := s.RefCount(sh); got != 2 {
		t.Fatalf("shared refs = %d, want 2", got)
	}
	mustVerify(t, s)

	if err := s.DeleteRoot(rootA); err != nil {
		t.Fatal(err)
	}
	if !s.Has(sh) || s.RefCount(sh) != 1 {
		t.Fatalf("shared block lost after deleting rootA (refs=%d)", s.RefCount(sh))
	}
	if got := s.BlockCount(); got != 2 {
		t.Fatalf("BlockCount = %d, want 2", got)
	}
	mustVerify(t, s)

	if err := s.DeleteRoot(rootB); err != nil {
		t.Fatal(err)
	}
	if got := s.BlockCount(); got != 0 {
		t.Fatalf("BlockCount = %d, want 0", got)
	}
	mustVerify(t, s)
}

// Diamond: R -> {B, C}, B -> D, C -> D. Deleting R must free D exactly once.
func TestDiamondNoDoubleFree(t *testing.T) {
	s := New()
	d := leaf("D")
	dh := HashOf(d)
	b := Node{Data: []byte("B"), Children: []Hash{dh}}
	c := Node{Data: []byte("C"), Children: []Hash{dh}}
	r := Node{Data: []byte("R"), Children: []Hash{HashOf(b), HashOf(c)}}

	root := mustAdd(t, s, d, b, c, r)
	if got := s.BlockCount(); got != 4 {
		t.Fatalf("BlockCount = %d, want 4", got)
	}
	if got := s.RefCount(dh); got != 2 {
		t.Fatalf("D refs = %d, want 2", got)
	}

	if err := s.DeleteRoot(root); err != nil {
		t.Fatal(err)
	}
	if got := s.BlockCount(); got != 0 {
		t.Fatalf("BlockCount = %d, want 0 (double-free or leak in diamond)", got)
	}
	mustVerify(t, s)
}

// A root referencing the same child through two edges holds two references.
func TestDuplicateChildEdges(t *testing.T) {
	s := New()
	a := leaf("A")
	ah := HashOf(a)
	r := Node{Data: []byte("R"), Children: []Hash{ah, ah}}

	root := mustAdd(t, s, a, r)
	if got := s.RefCount(ah); got != 2 {
		t.Fatalf("A refs = %d, want 2 (two edges)", got)
	}
	if err := s.DeleteRoot(root); err != nil {
		t.Fatal(err)
	}
	if got := s.BlockCount(); got != 0 {
		t.Fatalf("BlockCount = %d, want 0", got)
	}
	mustVerify(t, s)
}

// Cyclic inputs are rejected: self-loops and mutual references.
func TestCycleRejected(t *testing.T) {
	h1 := Hash{1}
	h2 := Hash{2}

	selfLoop := map[Hash]nodeBody{h1: {children: []Hash{h1}}}
	if err := checkAcyclic(selfLoop, []Hash{h1}); !errors.Is(err, ErrCycle) {
		t.Fatalf("self-loop: err = %v, want ErrCycle", err)
	}

	mutual := map[Hash]nodeBody{
		h1: {children: []Hash{h2}},
		h2: {children: []Hash{h1}},
	}
	if err := checkAcyclic(mutual, []Hash{h1, h2}); !errors.Is(err, ErrCycle) {
		t.Fatalf("mutual cycle: err = %v, want ErrCycle", err)
	}

	diamond := map[Hash]nodeBody{
		h1: {children: []Hash{h2}},
		h2: {},
	}
	if err := checkAcyclic(diamond, []Hash{h1, h2}); err != nil {
		t.Fatalf("acyclic graph rejected: %v", err)
	}
}

// A batch referencing a missing child is rejected and rolled back in full:
// even its valid nodes must not be committed.
func TestTransactionAtomicRollback(t *testing.T) {
	s := New()
	a := leaf("A")
	ah := HashOf(a)
	mustAdd(t, s, a)

	good := leaf("good")
	bad := Node{Data: []byte("bad"), Children: []Hash{{0xFF}}}
	_, err := s.AddRoot(good, bad)
	if !errors.Is(err, ErrUnknownChild) {
		t.Fatalf("err = %v, want ErrUnknownChild", err)
	}
	if got := s.BlockCount(); got != 1 {
		t.Fatalf("BlockCount = %d, want 1 (rollback)", got)
	}
	if s.Has(HashOf(good)) {
		t.Fatal("valid sibling node leaked into store after failed batch")
	}
	if got := s.RefCount(ah); got != 1 {
		t.Fatalf("existing refs = %d, want 1 (untouched)", got)
	}
	if len(s.Roots()) != 1 {
		t.Fatalf("Roots = %v, want the original root only", s.Roots())
	}
	mustVerify(t, s)
}

func TestDeleteRootErrors(t *testing.T) {
	s := New()
	if err := s.DeleteRoot(Hash{1}); !errors.Is(err, ErrNotRoot) {
		t.Fatalf("unknown root: err = %v, want ErrNotRoot", err)
	}

	a := leaf("A")
	ah := HashOf(a)
	root := mustAdd(t, s, a, Node{Data: []byte("R"), Children: []Hash{ah}})
	if err := s.DeleteRoot(ah); !errors.Is(err, ErrNotRoot) {
		t.Fatalf("deleting non-root child: err = %v, want ErrNotRoot", err)
	}
	if got := s.BlockCount(); got != 2 {
		t.Fatalf("BlockCount = %d, want 2 (untouched)", got)
	}
	if err := s.DeleteRoot(root); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteRoot(root); !errors.Is(err, ErrNotRoot) {
		t.Fatalf("double delete: err = %v, want ErrNotRoot", err)
	}
	mustVerify(t, s)
}

// Re-adding the same root pins it again; it stays live until the last
// DeleteRoot.
func TestRootRepinning(t *testing.T) {
	s := New()
	n := leaf("pinned")
	h := mustAdd(t, s, n)
	if h2 := mustAdd(t, s, n); h2 != h {
		t.Fatal("same tree, different root hash")
	}
	if !s.IsRoot(h) {
		t.Fatal("not a root")
	}
	if err := s.DeleteRoot(h); err != nil {
		t.Fatal(err)
	}
	if !s.IsRoot(h) || !s.Has(h) {
		t.Fatal("root unpinned while one pin remains")
	}
	if err := s.DeleteRoot(h); err != nil {
		t.Fatal(err)
	}
	if s.IsRoot(h) || s.Has(h) {
		t.Fatal("root still live after last delete")
	}
	mustVerify(t, s)
}

// Verify's full-scan model catches leaks and refcount corruption.
func TestVerifyDetectsCorruption(t *testing.T) {
	s := New()
	a := leaf("A")
	ah := HashOf(a)
	mustAdd(t, s, a)
	mustVerify(t, s)

	// Injected unreachable block -> leak.
	s.blocks[Hash{7}] = &block{refs: 1}
	if err := s.Verify(); err == nil || !strings.Contains(err.Error(), "leaked") {
		t.Fatalf("Verify = %v, want leak error", err)
	}
	delete(s.blocks, Hash{7})
	mustVerify(t, s)

	// Corrupted refcount -> mismatch against recomputed references.
	s.blocks[ah].refs = 99
	if err := s.Verify(); err == nil || !strings.Contains(err.Error(), "refs=99") {
		t.Fatalf("Verify = %v, want refcount mismatch", err)
	}
	s.blocks[ah].refs = 1
	mustVerify(t, s)
}

func TestEmptyBatchAndGet(t *testing.T) {
	s := New()
	if _, err := s.AddRoot(); !errors.Is(err, ErrEmptyBatch) {
		t.Fatalf("err = %v, want ErrEmptyBatch", err)
	}

	child := leaf("child")
	ch := HashOf(child)
	root := mustAdd(t, s, child, Node{Data: []byte("root"), Children: []Hash{ch}})

	got, ok := s.Get(root)
	if !ok {
		t.Fatal("Get(root): not found")
	}
	if string(got.Data) != "root" || len(got.Children) != 1 || got.Children[0] != ch {
		t.Fatalf("Get(root) = %+v", got)
	}
	if _, ok := s.Get(Hash{9}); ok {
		t.Fatal("Get(unknown) found a block")
	}
	mustVerify(t, s)
}
