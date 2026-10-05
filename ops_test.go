package bdd_test

import (
	"math/rand"
	"testing"

	"bdd"
)

// randomExpr builds a random formula, returning its BDD and its model
// truth table. Every intermediate handle is released after use.
func randomExpr(r *rand.Rand, m *bdd.Manager, numVars, depth int) (bdd.Node, []bool) {
	if depth == 0 {
		v := r.Intn(numVars)
		return m.Var(v), varTT(numVars, v)
	}
	switch r.Intn(8) {
	case 0:
		if r.Intn(2) == 0 {
			return bdd.False, constTT(numVars, false)
		}
		return bdd.True, constTT(numVars, true)
	case 1:
		v := r.Intn(numVars)
		return m.Var(v), varTT(numVars, v)
	case 2:
		a, ta := randomExpr(r, m, numVars, depth-1)
		h := m.Not(a)
		m.Release(a)
		return h, notTT(ta)
	case 3, 4, 5, 6:
		a, ta := randomExpr(r, m, numVars, depth-1)
		b, tb := randomExpr(r, m, numVars, depth-1)
		var h bdd.Node
		var tt []bool
		switch r.Intn(5) {
		case 0:
			h, tt = m.And(a, b), binTT(ta, tb, andOp)
		case 1:
			h, tt = m.Or(a, b), binTT(ta, tb, orOp)
		case 2:
			h, tt = m.Xor(a, b), binTT(ta, tb, xorOp)
		case 3:
			h, tt = m.Imply(a, b), binTT(ta, tb, impOp)
		default:
			h, tt = m.Equiv(a, b), binTT(ta, tb, eqvOp)
		}
		m.Release(a)
		m.Release(b)
		return h, tt
	default:
		i, ti := randomExpr(r, m, numVars, depth-1)
		th, tt := randomExpr(r, m, numVars, depth-1)
		e, te := randomExpr(r, m, numVars, depth-1)
		h := m.Ite(i, th, e)
		m.Release(i)
		m.Release(th)
		m.Release(e)
		return h, iteTT(ti, tt, te)
	}
}

func TestBoolOpsTruthTable(t *testing.T) {
	const n = 6
	r := rand.New(rand.NewSource(7))
	m, _ := bdd.NewManager(n)
	for iter := 0; iter < 100; iter++ {
		f, tf := randomExpr(r, m, n, 4)
		g, tg := randomExpr(r, m, n, 4)
		ng := m.Not(g)
		ops := []struct {
			name string
			h    bdd.Node
			tt   []bool
		}{
			{"And", m.And(f, g), binTT(tf, tg, andOp)},
			{"Or", m.Or(f, g), binTT(tf, tg, orOp)},
			{"Xor", m.Xor(f, g), binTT(tf, tg, xorOp)},
			{"Imply", m.Imply(f, g), binTT(tf, tg, impOp)},
			{"Equiv", m.Equiv(f, g), binTT(tf, tg, eqvOp)},
			{"Not", m.Not(f), notTT(tf)},
			{"Ite", m.Ite(f, g, ng), iteTT(tf, tg, notTT(tg))},
		}
		for _, op := range ops {
			checkTT(t, m, op.h, op.tt, op.name)
			m.Release(op.h)
		}
		m.Release(ng)
		m.Release(f)
		m.Release(g)
	}
	if m.NodeCount() != 0 {
		t.Fatalf("NodeCount = %d, want 0", m.NodeCount())
	}
}

func TestRandomFormulasTruthTable(t *testing.T) {
	const n = 8
	r := rand.New(rand.NewSource(99))
	m, _ := bdd.NewManager(n)
	for iter := 0; iter < 200; iter++ {
		h, tt := randomExpr(r, m, n, 6)
		checkTT(t, m, h, tt, "random formula")
		m.Release(h)
	}
	if m.NodeCount() != 0 {
		t.Fatalf("NodeCount = %d, want 0", m.NodeCount())
	}
}

func TestExistsTruthTable(t *testing.T) {
	const n = 8
	r := rand.New(rand.NewSource(13))
	m, _ := bdd.NewManager(n)
	for iter := 0; iter < 60; iter++ {
		f, tf := randomExpr(r, m, n, 5)
		k := r.Intn(5) // quantify 0..4 variables
		qs := make(map[int]bool)
		vars := []int{}
		for len(qs) < k {
			v := r.Intn(n)
			if !qs[v] {
				qs[v] = true
				vars = append(vars, v)
			}
		}
		ex := m.Exists(f, vars...)
		checkTT(t, m, ex, quantifyTT(tf, qs, true), "Exists")
		fa := m.ForAll(f, vars...)
		checkTT(t, m, fa, quantifyTT(tf, qs, false), "ForAll")
		m.Release(ex)
		m.Release(fa)
		m.Release(f)
	}
	if m.NodeCount() != 0 {
		t.Fatalf("NodeCount = %d, want 0", m.NodeCount())
	}
}

func TestExistsAllVarsGivesConstant(t *testing.T) {
	const n = 5
	r := rand.New(rand.NewSource(21))
	m, _ := bdd.NewManager(n)
	for iter := 0; iter < 30; iter++ {
		f, tf := randomExpr(r, m, n, 4)
		all := []int{0, 1, 2, 3, 4}
		ex := m.Exists(f, all...)
		sat := false
		for _, v := range tf {
			sat = sat || v
		}
		want := bdd.False
		if sat {
			want = bdd.True
		}
		if ex != want {
			t.Fatalf("Exists over all vars = %d, want %d", ex, want)
		}
		m.Release(ex)
		m.Release(f)
	}
}

func TestExistsBadVarPanics(t *testing.T) {
	m, _ := bdd.NewManager(2)
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic for Exists with bad variable")
		}
	}()
	m.Exists(bdd.True, 5)
}
