package bdd_test

import (
	"testing"

	"bdd"
)

func TestReleaseKeepsSharedNodes(t *testing.T) {
	m, _ := bdd.NewManager(4)
	x, y := m.Var(0), m.Var(1)
	f := m.And(x, y)
	g := m.Or(x, y)
	ttG := m.TruthTable(g)
	ttX := m.TruthTable(x)

	m.Release(f) // frees the AND node only; x, y are shared with g

	checkTT(t, m, g, ttG, "g survives Release(f)")
	checkTT(t, m, x, ttX, "x survives Release(f)")
	if !m.Valid(g) || !m.Valid(x) || !m.Valid(y) {
		t.Fatal("Release deleted a live node")
	}

	// The unique table still knows the shared sub-nodes: rebuilding the
	// released conjunction must return the very same nodes.
	f2 := m.And(x, y)
	checkTT(t, m, f2, binTT(varTT(4, 0), varTT(4, 1), andOp), "rebuilt f")
	m.Release(f2)
	m.Release(g)
	m.Release(x)
	m.Release(y)
	if m.NodeCount() != 0 {
		t.Fatalf("NodeCount = %d, want 0", m.NodeCount())
	}
}

func TestReleaseCascadeStopsAtLiveNodes(t *testing.T) {
	m, _ := bdd.NewManager(3)
	x, y, z := m.Var(0), m.Var(1), m.Var(2)
	sub := m.And(x, y)  // shared sub-formula, externally referenced
	big := m.Or(sub, z) // references sub internally
	ttSub := m.TruthTable(sub)
	subID := sub

	m.Release(big) // must free only the OR node, not sub's nodes

	if !m.Valid(subID) {
		t.Fatal("Release(big) deleted the still-referenced sub-formula")
	}
	checkTT(t, m, sub, ttSub, "sub after releasing its parent")
	if again := m.And(x, y); again != subID {
		m.Release(again)
		t.Fatal("shared sub-formula lost its unique-table entry")
	} else {
		m.Release(again)
	}
	m.Release(sub)
	m.Release(x)
	m.Release(y)
	m.Release(z)
	if m.NodeCount() != 0 {
		t.Fatalf("NodeCount = %d, want 0", m.NodeCount())
	}
}

func TestRefProtectsAgainstRelease(t *testing.T) {
	m, _ := bdd.NewManager(2)
	h := m.Var(0)
	m.Ref(h) // second external reference
	m.Release(h)
	if !m.Valid(h) {
		t.Fatal("node deleted while still referenced")
	}
	checkTT(t, m, h, varTT(2, 0), "h after one Release")
	m.Release(h)
	if m.Valid(h) && m.NodeCount() != 0 {
		t.Fatal("node should be gone after the last Release")
	}
	if m.NodeCount() != 0 {
		t.Fatalf("NodeCount = %d, want 0", m.NodeCount())
	}
}

func TestDeepChainReleaseAndReuse(t *testing.T) {
	const n = 8
	m, _ := bdd.NewManager(n)
	vars := make([]bdd.Node, n)
	for i := range vars {
		vars[i] = m.Var(i)
	}
	h := vars[0]
	m.Ref(h)
	for i := 1; i < n; i++ {
		g := m.And(h, vars[i])
		m.Release(h)
		h = g
	}
	tt := m.TruthTable(h)
	m.Release(h) // whole AND chain must be collected
	if got := m.NodeCount(); got != n {
		t.Fatalf("NodeCount = %d, want %d (only the var nodes)", got, n)
	}
	// Rebuild the same chain: freed ids may be reused, results must stay correct.
	h2 := vars[0]
	m.Ref(h2)
	for i := 1; i < n; i++ {
		g := m.And(h2, vars[i])
		m.Release(h2)
		h2 = g
	}
	checkTT(t, m, h2, tt, "rebuilt chain after reuse")
	m.Release(h2)
	for _, v := range vars {
		m.Release(v)
	}
	if m.NodeCount() != 0 {
		t.Fatalf("NodeCount = %d, want 0", m.NodeCount())
	}
}
