package geom

import (
	"math/rand"
	"testing"
)

// checkTreap verifies BST order, heap priority, and size bookkeeping.
func checkTreap(t *testing.T, n *node, lo, hi int64) int {
	t.Helper()
	if n == nil {
		return 0
	}
	if n.id <= lo || n.id >= hi {
		t.Fatalf("BST order violated at id %d", n.id)
	}
	if n.prio != prioOf(n.id) {
		t.Fatalf("priority mismatch at id %d", n.id)
	}
	if n.left != nil && n.left.prio < n.prio {
		t.Fatalf("heap property violated at id %d", n.id)
	}
	if n.right != nil && n.right.prio < n.prio {
		t.Fatalf("heap property violated at id %d", n.id)
	}
	ls := checkTreap(t, n.left, lo, n.id)
	rs := checkTreap(t, n.right, n.id, hi)
	if n.size != 1+ls+rs {
		t.Fatalf("size mismatch at id %d: %d != %d", n.id, n.size, 1+ls+rs)
	}
	return n.size
}

const maxInt64 = int64(^uint64(0) >> 1)

func countShared(a, b *node, seen map[*node]bool) int {
	if a == nil {
		return 0
	}
	if seen[a] {
		return 0
	}
	seen[a] = true
	shared := 0
	if containsNode(b, a) {
		shared = 1
	}
	return shared + countShared(a.left, b, seen) + countShared(a.right, b, seen)
}

func containsNode(root, want *node) bool {
	if root == nil {
		return false
	}
	return root == want || containsNode(root.left, want) || containsNode(root.right, want)
}

func TestTreapStructureAndSharing(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	s := New()
	ref := map[int64]Point{}
	for i := 0; i < 2000; i++ {
		id := int64(rng.Intn(500))
		if rng.Intn(4) == 0 {
			s = s.Remove(id)
			delete(ref, id)
		} else {
			p := Point{X: int64(rng.Intn(50)), Y: int64(rng.Intn(50))}
			s = s.Add(id, p)
			ref[id] = p
		}
	}
	checkTreap(t, s.root, -1, maxInt64)
	if s.Len() != len(ref) {
		t.Fatalf("Len = %d, want %d", s.Len(), len(ref))
	}
	for _, e := range s.Entries() {
		if ref[e.ID] != e.P {
			t.Fatalf("entry %d = %v, want %v", e.ID, e.P, ref[e.ID])
		}
	}

	// A single update copies only the spine: the new root must share the
	// vast majority of nodes with the old one.
	before := s.Len()
	s2 := s.Add(12345, Point{X: 1, Y: 1})
	shared := countShared(s2.root, s.root, map[*node]bool{})
	if shared < before-30 {
		t.Fatalf("only %d of %d nodes shared after one insert", shared, before)
	}
	if s.Len() != before {
		t.Fatalf("receiver mutated: len %d -> %d", before, s.Len())
	}
}
