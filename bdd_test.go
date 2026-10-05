package bdd_test

import (
	"testing"

	"bdd"
)

// --- truth-table model helpers ---

func ttEqual(a, b []bool) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func constTT(numVars int, val bool) []bool {
	tt := make([]bool, 1<<uint(numVars))
	for i := range tt {
		tt[i] = val
	}
	return tt
}

func varTT(numVars, v int) []bool {
	tt := make([]bool, 1<<uint(numVars))
	for a := range tt {
		tt[a] = a>>uint(v)&1 == 1
	}
	return tt
}

func notTT(f []bool) []bool {
	tt := make([]bool, len(f))
	for a, v := range f {
		tt[a] = !v
	}
	return tt
}

func binTT(f, g []bool, op func(bool, bool) bool) []bool {
	tt := make([]bool, len(f))
	for a := range f {
		tt[a] = op(f[a], g[a])
	}
	return tt
}

func andOp(a, b bool) bool { return a && b }
func orOp(a, b bool) bool  { return a || b }
func xorOp(a, b bool) bool { return a != b }
func impOp(a, b bool) bool { return !a || b }
func eqvOp(a, b bool) bool { return a == b }

func iteTT(i, t, e []bool) []bool {
	tt := make([]bool, len(i))
	for a := range i {
		if i[a] {
			tt[a] = t[a]
		} else {
			tt[a] = e[a]
		}
	}
	return tt
}

// quantifyTT models quantification: entry a of the result only depends on
// the non-quantified variables of a.
func quantifyTT(f []bool, qs map[int]bool, existential bool) []bool {
	var qmask uint64
	for v := range qs {
		qmask |= 1 << uint(v)
	}
	acc := make([]bool, len(f))
	if !existential {
		for i := range acc {
			acc[i] = true
		}
	}
	for a, val := range f {
		idx := uint64(a) &^ qmask
		if existential {
			acc[idx] = acc[idx] || val
		} else {
			acc[idx] = acc[idx] && val
		}
	}
	tt := make([]bool, len(f))
	for a := range tt {
		tt[a] = acc[uint64(a)&^qmask]
	}
	return tt
}

func checkTT(t *testing.T, m *bdd.Manager, h bdd.Node, want []bool, what string) {
	t.Helper()
	if got := m.TruthTable(h); !ttEqual(got, want) {
		t.Fatalf("%s: truth table mismatch", what)
	}
}

// --- core tests ---

func TestNewManagerLimits(t *testing.T) {
	for _, n := range []int{0, 1, 8, 16} {
		if _, err := bdd.NewManager(n); err != nil {
			t.Fatalf("NewManager(%d): %v", n, err)
		}
	}
	for _, n := range []int{-1, 17, 100} {
		if _, err := bdd.NewManager(n); err != bdd.ErrTooManyVars {
			t.Fatalf("NewManager(%d): got %v, want ErrTooManyVars", n, err)
		}
	}
}

func TestConstantsAndVars(t *testing.T) {
	m, err := bdd.NewManager(4)
	if err != nil {
		t.Fatal(err)
	}
	checkTT(t, m, bdd.False, constTT(4, false), "False")
	checkTT(t, m, bdd.True, constTT(4, true), "True")
	for v := 0; v < 4; v++ {
		h := m.Var(v)
		checkTT(t, m, h, varTT(4, v), "Var")
		m.Release(h)
	}
	if m.NodeCount() != 0 {
		t.Fatalf("NodeCount = %d, want 0", m.NodeCount())
	}
}

func TestVarPanicsOnBadIndex(t *testing.T) {
	m, _ := bdd.NewManager(3)
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for Var(3)")
		}
	}()
	m.Var(3)
}

func TestEval(t *testing.T) {
	m, _ := bdd.NewManager(2)
	x, y := m.Var(0), m.Var(1)
	f := m.Xor(x, y) // x != y
	cases := []struct {
		assign []bool
		want   bool
	}{
		{[]bool{false, false}, false},
		{[]bool{false, true}, true},
		{[]bool{true, false}, true},
		{[]bool{true, true}, false},
	}
	for _, c := range cases {
		if got := m.Eval(f, c.assign); got != c.want {
			t.Fatalf("Eval(%v) = %v, want %v", c.assign, got, c.want)
		}
	}
}

func TestSharingAndReduction(t *testing.T) {
	m, _ := bdd.NewManager(4)
	x, y := m.Var(0), m.Var(1)

	a1 := m.And(x, y)
	a2 := m.And(x, y)
	if a1 != a2 {
		t.Fatal("identical computations must share one node")
	}

	nx := m.Not(x)
	if got := m.Or(x, nx); got != bdd.True {
		t.Fatal("x OR NOT x must reduce to True")
	}
	if got := m.And(x, nx); got != bdd.False {
		t.Fatal("x AND NOT x must reduce to False")
	}
	if got := m.And(x, bdd.True); got != x {
		t.Fatal("x AND True must be x")
	}
	if got := m.Or(x, bdd.False); got != x {
		t.Fatal("x OR False must be x")
	}
	if got := m.Xor(x, x); got != bdd.False {
		t.Fatal("x XOR x must be False")
	}
	if got := m.Imply(x, x); got != bdd.True {
		t.Fatal("x IMPLY x must be True")
	}
	if got := m.Equiv(x, x); got != bdd.True {
		t.Fatal("x EQUIV x must be True")
	}
	if got := m.Not(m.Not(x)); got != x {
		t.Fatal("double negation must return the shared node")
	}
	if got := m.And(y, x); got != a1 {
		t.Fatal("AND must be commutative up to node sharing")
	}
}

func TestSupport(t *testing.T) {
	m, _ := bdd.NewManager(5)
	f := m.And(m.Var(3), m.Or(m.Var(0), m.Var(4)))
	got := m.Support(f)
	want := []int{0, 3, 4}
	if len(got) != len(want) {
		t.Fatalf("Support = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Support = %v, want %v", got, want)
		}
	}
}
