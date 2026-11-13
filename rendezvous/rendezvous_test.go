package rendezvous

import (
	"fmt"
	"math"
	"testing"
)

func testNodes(n, domains int) []Node {
	nodes := make([]Node, n)
	for i := range nodes {
		nodes[i] = Node{
			ID:     fmt.Sprintf("node-%02d", i),
			Domain: fmt.Sprintf("domain-%d", i%domains),
			Weight: 1,
		}
	}
	return nodes
}

func testKeys(n int) []string {
	keys := make([]string, n)
	for i := range keys {
		keys[i] = fmt.Sprintf("key-%06d", i)
	}
	return keys
}

func mustSnapshot(t *testing.T, version uint64, nodes []Node) *Snapshot {
	t.Helper()
	s, err := NewSnapshot(version, nodes)
	if err != nil {
		t.Fatalf("NewSnapshot: %v", err)
	}
	return s
}

func TestNewSnapshotValidation(t *testing.T) {
	if _, err := NewSnapshot(1, nil); err == nil {
		t.Fatal("expected error for empty membership")
	}
	if _, err := NewSnapshot(1, []Node{{ID: "a"}, {ID: "a"}}); err == nil {
		t.Fatal("expected error for duplicate IDs")
	}
	if _, err := NewSnapshot(1, []Node{{ID: ""}}); err == nil {
		t.Fatal("expected error for empty ID")
	}
	for _, w := range []float64{-1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, err := NewSnapshot(1, []Node{{ID: "a", Weight: w}}); err == nil {
			t.Fatalf("expected error for weight %v", w)
		}
	}
}

func TestSnapshotAccessors(t *testing.T) {
	s := mustSnapshot(t, 42, testNodes(5, 2))
	if s.Version() != 42 {
		t.Fatalf("Version() = %d, want 42", s.Version())
	}
	if s.Size() != 5 {
		t.Fatalf("Size() = %d, want 5", s.Size())
	}
	nodes := s.Nodes()
	for i := 1; i < len(nodes); i++ {
		if nodes[i-1].ID >= nodes[i].ID {
			t.Fatalf("Nodes() not sorted by ID: %q >= %q", nodes[i-1].ID, nodes[i].ID)
		}
	}
}

func TestDeterministicRouting(t *testing.T) {
	// Same membership in different input orders must route identically.
	a := mustSnapshot(t, 1, testNodes(8, 4))
	reversed := testNodes(8, 4)
	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	b := mustSnapshot(t, 1, reversed)

	for _, key := range testKeys(2000) {
		na, _ := a.Lookup(key)
		nb, _ := b.Lookup(key)
		if na.ID != nb.ID {
			t.Fatalf("key %q routed to %q and %q", key, na.ID, nb.ID)
		}
	}
}

func TestGoldenRouting(t *testing.T) {
	// Golden values pin the exact routing so any change to the scoring
	// formula (or platform-dependent behavior) is caught.
	s := mustSnapshot(t, 1, []Node{
		{ID: "alpha", Domain: "dc1", Weight: 1},
		{ID: "bravo", Domain: "dc1", Weight: 2},
		{ID: "charlie", Domain: "dc2", Weight: 1},
		{ID: "delta", Domain: "dc3", Weight: 1},
	})
	want := map[string][]string{
		"key-000000": {"delta", "bravo", "charlie"},
		"key-000001": {"alpha", "charlie", "delta"},
		"key-000002": {"bravo", "charlie", "delta"},
		"key-000003": {"bravo", "charlie", "delta"},
		"key-000004": {"bravo", "charlie", "delta"},
		"key-000005": {"delta", "alpha", "charlie"},
		"key-000006": {"bravo", "charlie", "delta"},
		"key-000007": {"charlie", "delta", "alpha"},
		"key-000008": {"alpha", "charlie", "delta"},
		"key-000009": {"bravo", "charlie", "delta"},
	}
	for key, wantIDs := range want {
		got := s.LookupN(key, 3)
		if len(got) != len(wantIDs) {
			t.Fatalf("LookupN(%q) returned %d nodes, want %d", key, len(got), len(wantIDs))
		}
		for i, id := range wantIDs {
			if got[i].ID != id {
				t.Fatalf("LookupN(%q)[%d] = %q, want %q", key, i, got[i].ID, id)
			}
		}
	}
}

func TestLookupNDistinctDomains(t *testing.T) {
	s := mustSnapshot(t, 1, testNodes(9, 3))
	for _, key := range testKeys(500) {
		replicas := s.LookupN(key, 3)
		if len(replicas) != 3 {
			t.Fatalf("LookupN(%q) returned %d nodes, want 3", key, len(replicas))
		}
		seenDomains := map[string]bool{}
		seenIDs := map[string]bool{}
		for _, n := range replicas {
			if seenDomains[n.Domain] {
				t.Fatalf("key %q: domain %q repeated in %+v", key, n.Domain, replicas)
			}
			if seenIDs[n.ID] {
				t.Fatalf("key %q: node %q repeated in %+v", key, n.ID, replicas)
			}
			seenDomains[n.Domain] = true
			seenIDs[n.ID] = true
		}
	}
}

func TestLookupNFillsWhenDomainsExhausted(t *testing.T) {
	// 4 nodes in 2 domains: asking for 3 replicas must still return 3
	// distinct nodes, reusing a domain only as a fallback.
	s := mustSnapshot(t, 1, testNodes(4, 2))
	replicas := s.LookupN("some-key", 3)
	if len(replicas) != 3 {
		t.Fatalf("got %d replicas, want 3", len(replicas))
	}
	seen := map[string]bool{}
	for _, n := range replicas {
		if seen[n.ID] {
			t.Fatalf("duplicate node %q in %+v", n.ID, replicas)
		}
		seen[n.ID] = true
	}
}

func TestLookupNEdgeCases(t *testing.T) {
	s := mustSnapshot(t, 1, testNodes(3, 3))
	if got := s.LookupN("k", 0); got != nil {
		t.Fatalf("LookupN n=0 = %v, want nil", got)
	}
	if got := s.LookupN("k", 10); len(got) != 3 {
		t.Fatalf("LookupN n>size returned %d nodes, want 3", len(got))
	}
}

func TestMinimalDisruptionOnNodeRemoval(t *testing.T) {
	const nodeCount = 10
	nodes := testNodes(nodeCount, nodeCount)
	before := mustSnapshot(t, 1, nodes)

	removed := nodes[3]
	after := mustSnapshot(t, 2, append(append([]Node{}, nodes[:3]...), nodes[4:]...))

	keys := testKeys(20000)
	moved := 0
	for _, key := range keys {
		b, _ := before.Lookup(key)
		a, _ := after.Lookup(key)
		if b.ID == a.ID {
			continue
		}
		moved++
		// The defining property of rendezvous hashing: only keys that were
		// on the removed node may move.
		if b.ID != removed.ID {
			t.Fatalf("key %q moved from %q though node still present", key, b.ID)
		}
	}
	ratio := float64(moved) / float64(len(keys))
	if ratio < 0.05 || ratio > 0.18 {
		t.Fatalf("moved ratio %v outside expected range around 1/%d", ratio, nodeCount)
	}
}

func TestMinimalDisruptionOnNodeAdd(t *testing.T) {
	nodes := testNodes(10, 10)
	before := mustSnapshot(t, 1, nodes)
	after := mustSnapshot(t, 2, append(append([]Node{}, nodes...), Node{ID: "node-new", Domain: "domain-new", Weight: 1}))

	keys := testKeys(20000)
	moved := 0
	for _, key := range keys {
		b, _ := before.Lookup(key)
		a, _ := after.Lookup(key)
		if b.ID != a.ID {
			moved++
			if a.ID != "node-new" {
				t.Fatalf("key %q moved to %q instead of the new node", key, a.ID)
			}
		}
	}
	ratio := float64(moved) / float64(len(keys))
	if ratio < 0.05 || ratio > 0.18 {
		t.Fatalf("moved ratio %v outside expected range around 1/11", ratio)
	}
}

func TestWeightsShiftLoad(t *testing.T) {
	s := mustSnapshot(t, 1, []Node{
		{ID: "light", Domain: "d1", Weight: 1},
		{ID: "heavy", Domain: "d2", Weight: 3},
	})
	counts := map[string]int{}
	keys := testKeys(20000)
	for _, key := range keys {
		n, _ := s.Lookup(key)
		counts[n.ID]++
	}
	ratio := float64(counts["heavy"]) / float64(counts["light"])
	if ratio < 2.2 || ratio > 3.8 {
		t.Fatalf("heavy/light ratio %v, want roughly 3 (counts: %v)", ratio, counts)
	}
}

func TestNegLnFixed32Accuracy(t *testing.T) {
	// The fixed-point -ln(u) must track math.Log closely; this guards the
	// deterministic integer formula against implementation drift.
	x := uint64(0x9e3779b97f4a7c15)
	for i := 0; i < 200000; i++ {
		x = x*6364136223846793005 + 1442695040888963407
		got := float64(negLnFixed32(x)) / (1 << 32)
		want := -math.Log(float64(x) / math.Exp2(64))
		if want < 1e-4 {
			continue // fixed-point resolution dominates near zero
		}
		if rel := math.Abs(got-want) / want; rel > 1e-6 {
			t.Fatalf("negLnFixed32(%d) = %v, want %v (rel err %v)", x, got, want, rel)
		}
	}
}

func TestMigrationTo(t *testing.T) {
	nodes := testNodes(8, 4)
	before := mustSnapshot(t, 1, nodes)
	after := mustSnapshot(t, 2, append(append([]Node{}, nodes[:3]...), nodes[4:]...))

	keys := testKeys(5000)
	m := before.MigrationTo(after, keys, 3)
	if m.Keys != len(keys) {
		t.Fatalf("Keys = %d, want %d", m.Keys, len(keys))
	}
	if m.PrimaryMoved == 0 || m.ReplicaMoved == 0 {
		t.Fatalf("expected some movement, got %+v", m)
	}
	if m.ReplicaMoved < m.PrimaryMoved {
		t.Fatalf("ReplicaMoved %d < PrimaryMoved %d", m.ReplicaMoved, m.PrimaryMoved)
	}
	wantPrimary := float64(m.PrimaryMoved) / float64(m.Keys)
	if m.PrimaryRatio != wantPrimary {
		t.Fatalf("PrimaryRatio = %v, want %v", m.PrimaryRatio, wantPrimary)
	}
	// Removing 1 of 8 nodes should move roughly 1/8 of primaries.
	if m.PrimaryRatio < 0.06 || m.PrimaryRatio > 0.22 {
		t.Fatalf("PrimaryRatio %v outside expected range", m.PrimaryRatio)
	}

	same := before.MigrationTo(before, keys, 3)
	if same.PrimaryMoved != 0 || same.ReplicaMoved != 0 || same.PrimaryRatio != 0 || same.ReplicaRatio != 0 {
		t.Fatalf("self-comparison should report zero movement, got %+v", same)
	}

	empty := before.MigrationTo(after, nil, 3)
	if empty.Keys != 0 || empty.PrimaryRatio != 0 || empty.ReplicaRatio != 0 {
		t.Fatalf("empty key set should report zeros, got %+v", empty)
	}
}
