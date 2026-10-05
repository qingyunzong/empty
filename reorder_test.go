package bdd_test

import (
	"math/rand"
	"testing"

	"bdd"
)

// checkCanonical verifies that every path of h follows the current
// variable order strictly and that no node is redundant.
func checkCanonical(t *testing.T, m *bdd.Manager, root bdd.Node) {
	t.Helper()
	seen := make(map[bdd.Node]bool)
	var walk func(f bdd.Node)
	walk = func(f bdd.Node) {
		if m.IsConst(f) || seen[f] {
			return
		}
		seen[f] = true
		v := m.VarOf(f)
		for _, c := range []bdd.Node{m.Low(f), m.High(f)} {
			if m.IsConst(c) {
				continue
			}
			if m.LevelOf(m.VarOf(c)) <= m.LevelOf(v) {
				t.Fatalf("order violated: var %d (level %d) above var %d (level %d)",
					v, m.LevelOf(v), m.VarOf(c), m.LevelOf(m.VarOf(c)))
			}
			walk(c)
		}
		if m.Low(f) == m.High(f) {
			t.Fatalf("redundant node for var %d", v)
		}
	}
	walk(root)
}

func TestReorderPreservesHandles(t *testing.T) {
	const n = 8
	r := rand.New(rand.NewSource(31))
	m, _ := bdd.NewManager(n)
	type entry struct {
		h  bdd.Node
		tt []bool
	}
	var live []entry
	for i := 0; i < 10; i++ {
		h, tt := randomExpr(r, m, n, 5)
		live = append(live, entry{h, tt})
	}
	// Apply a sequence of random permutations and adjacent swaps; old
	// handles must keep denoting the same function throughout.
	for step := 0; step < 20; step++ {
		if r.Intn(2) == 0 {
			if err := m.Reorder(r.Perm(n)); err != nil {
				t.Fatal(err)
			}
		} else {
			if err := m.SwapAdjacent(r.Intn(n - 1)); err != nil {
				t.Fatal(err)
			}
		}
		for _, e := range live {
			checkTT(t, m, e.h, e.tt, "old handle after reorder")
		}
	}
	// Operations mixing old handles still match the truth-table model.
	a, b := live[0], live[1]
	h := m.And(a.h, b.h)
	checkTT(t, m, h, binTT(a.tt, b.tt, andOp), "And after reorder")
	m.Release(h)
	ex := m.Exists(a.h, 0, 3)
	checkTT(t, m, ex, quantifyTT(a.tt, map[int]bool{0: true, 3: true}, true), "Exists after reorder")
	m.Release(ex)
	for _, e := range live {
		m.Release(e.h)
	}
	if m.NodeCount() != 0 {
		t.Fatalf("NodeCount = %d, want 0", m.NodeCount())
	}
}

func TestRebuildCanonicalizes(t *testing.T) {
	const n = 6
	r := rand.New(rand.NewSource(47))
	m, _ := bdd.NewManager(n)
	for iter := 0; iter < 30; iter++ {
		h, tt := randomExpr(r, m, n, 5)
		if err := m.Reorder(r.Perm(n)); err != nil {
			t.Fatal(err)
		}
		rb := m.Rebuild(h)
		checkTT(t, m, rb, tt, "Rebuild preserves function")
		checkCanonical(t, m, rb)
		// Rebuilding again must return the same shared node.
		if again := m.Rebuild(rb); again != rb {
			t.Fatal("Rebuild of a canonical node must be a fixed point")
		} else {
			m.Release(again)
		}
		m.Release(rb)
		m.Release(h)
	}
	if m.NodeCount() != 0 {
		t.Fatalf("NodeCount = %d, want 0", m.NodeCount())
	}
}

func TestReorderAffectsSize(t *testing.T) {
	const n = 8
	// f = (x0&x1) | (x2&x3) | (x4&x5) | (x6&x7): compact when pairs are
	// adjacent in the order, larger when the pairs are split apart.
	build := func(m *bdd.Manager) (bdd.Node, []bool) {
		vars := make([]bdd.Node, n)
		for i := range vars {
			vars[i] = m.Var(i)
		}
		f := bdd.False
		tt := constTT(n, false)
		for i := 0; i < n; i += 2 {
			pair := m.And(vars[i], vars[i+1])
			g := m.Or(f, pair)
			tt = binTT(tt, binTT(varTT(n, i), varTT(n, i+1), andOp), orOp)
			m.Release(f)
			m.Release(pair)
			f = g
		}
		for _, v := range vars {
			m.Release(v)
		}
		return f, tt
	}
	m, _ := bdd.NewManager(n)
	f, tt := build(m)
	good := m.Rebuild(f)
	checkCanonical(t, m, good)
	sizeGood := m.NodeCount()

	split := []int{0, 2, 4, 6, 1, 3, 5, 7}
	if err := m.Reorder(split); err != nil {
		t.Fatal(err)
	}
	bad := m.Rebuild(f)
	checkCanonical(t, m, bad)
	sizeBad := m.NodeCount()
	checkTT(t, m, bad, tt, "rebuilt under split order")
	checkTT(t, m, good, tt, "rebuilt under grouped order")
	checkTT(t, m, f, tt, "original handle after reorders")

	if sizeBad <= sizeGood {
		t.Fatalf("split order size %d should exceed grouped order size %d", sizeBad, sizeGood)
	}
	m.Release(bad)
	m.Release(good)
	m.Release(f)
	if m.NodeCount() != 0 {
		t.Fatalf("NodeCount = %d, want 0", m.NodeCount())
	}
}

func TestReorderValidation(t *testing.T) {
	m, _ := bdd.NewManager(3)
	for _, p := range [][]int{
		{0, 1},
		{0, 1, 1},
		{0, 1, 3},
		{0, 1, 2, 3},
	} {
		if err := m.Reorder(p); err != bdd.ErrBadPerm {
			t.Fatalf("Reorder(%v) = %v, want ErrBadPerm", p, err)
		}
	}
	if err := m.Reorder([]int{2, 0, 1}); err != nil {
		t.Fatal(err)
	}
	if got := m.Order(); got[0] != 2 || got[1] != 0 || got[2] != 1 {
		t.Fatalf("Order = %v", got)
	}
	if err := m.SwapAdjacent(2); err != bdd.ErrBadVar {
		t.Fatalf("SwapAdjacent(2) = %v, want ErrBadVar", err)
	}
	if err := m.SwapAdjacent(-1); err != bdd.ErrBadVar {
		t.Fatalf("SwapAdjacent(-1) = %v, want ErrBadVar", err)
	}
}
