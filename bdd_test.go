package bdd

import "testing"

// truthCheck enumerates the complete truth table (all 2^numVars assignments)
// and compares h against the reference function want.
func truthCheck(t *testing.T, h *Node, numVars int, want func(a []bool) bool) {
	t.Helper()
	for i := 0; i < 1<<numVars; i++ {
		a := make([]bool, numVars)
		for b := 0; b < numVars; b++ {
			a[b] = i>>b&1 == 1
		}
		if got := h.Eval(a); got != want(a) {
			t.Fatalf("assignment %v: got %v, want %v", a, got, want(a))
		}
	}
}

func assignment(i, numVars int) []bool {
	a := make([]bool, numVars)
	for b := 0; b < numVars; b++ {
		a[b] = i>>b&1 == 1
	}
	return a
}

func TestNewManagerLimits(t *testing.T) {
	for _, n := range []int{0, 1, 8, MaxVars} {
		if _, err := NewManager(n); err != nil {
			t.Fatalf("NewManager(%d): unexpected error %v", n, err)
		}
	}
	for _, n := range []int{-1, MaxVars + 1, 100} {
		if _, err := NewManager(n); err == nil {
			t.Fatalf("NewManager(%d): expected error", n)
		}
	}
}

func TestConstAndVar(t *testing.T) {
	m, err := NewManager(4)
	if err != nil {
		t.Fatal(err)
	}
	truthCheck(t, m.Const(true), 4, func(a []bool) bool { return true })
	truthCheck(t, m.Const(false), 4, func(a []bool) bool { return false })
	for v := 0; v < 4; v++ {
		v := v
		truthCheck(t, m.Var(v), 4, func(a []bool) bool { return a[v] })
	}
}

func TestBoolOps(t *testing.T) {
	const nv = 5
	m, err := NewManager(nv)
	if err != nil {
		t.Fatal(err)
	}
	x := make([]*Node, nv)
	for i := range x {
		x[i] = m.Var(i)
	}
	a, b, c := x[0], x[1], x[2]

	ops := []struct {
		name string
		got  *Node
		want func(a []bool) bool
	}{
		{"And", m.And(a, b), func(s []bool) bool { return s[0] && s[1] }},
		{"Or", m.Or(a, b), func(s []bool) bool { return s[0] || s[1] }},
		{"Xor", m.Xor(a, b), func(s []bool) bool { return s[0] != s[1] }},
		{"Nand", m.Nand(a, b), func(s []bool) bool { return !(s[0] && s[1]) }},
		{"Nor", m.Nor(a, b), func(s []bool) bool { return !(s[0] || s[1]) }},
		{"Implies", m.Implies(a, b), func(s []bool) bool { return !s[0] || s[1] }},
		{"Not", m.Not(a), func(s []bool) bool { return !s[0] }},
		{"NotNot", m.Not(m.Not(a)), func(s []bool) bool { return s[0] }},
		{"Ite", m.Ite(a, b, c), func(s []bool) bool {
			if s[0] {
				return s[1]
			}
			return s[2]
		}},
		{"Nested", m.Or(m.And(a, m.Not(b)), m.Xor(c, x[3])), func(s []bool) bool {
			return (s[0] && !s[1]) || (s[2] != s[3])
		}},
	}
	for _, tc := range ops {
		t.Run(tc.name, func(t *testing.T) {
			truthCheck(t, tc.got, nv, tc.want)
		})
	}
}

func TestExists(t *testing.T) {
	const nv = 5
	m, err := NewManager(nv)
	if err != nil {
		t.Fatal(err)
	}
	x := func(i int) *Node { return m.Var(i) }
	// f = (x0 AND x1) OR (x2 AND NOT x3)
	f := m.Or(m.And(x(0), x(1)), m.And(x(2), m.Not(x(3))))
	fref := func(s []bool) bool { return (s[0] && s[1]) || (s[2] && !s[3]) }
	truthCheck(t, f, nv, fref)

	// exists x1: full truth table against naive enumeration
	g := m.Exists(f, 1)
	truthCheck(t, g, nv, func(s []bool) bool {
		for _, v := range []bool{false, true} {
			s2 := append([]bool(nil), s...)
			s2[1] = v
			if fref(s2) {
				return true
			}
		}
		return false
	})

	// exists over several variables
	h := m.Exists(f, 0, 2, 3)
	truthCheck(t, h, nv, func(s []bool) bool {
		for bits := 0; bits < 8; bits++ {
			s2 := append([]bool(nil), s...)
			s2[0] = bits&1 == 1
			s2[2] = bits>>1&1 == 1
			s2[3] = bits>>2&1 == 1
			if fref(s2) {
				return true
			}
		}
		return false
	})

	// quantifying every variable yields a constant
	c := m.Exists(f, 0, 1, 2, 3, 4)
	truthCheck(t, c, nv, func(s []bool) bool {
		for i := 0; i < 1<<nv; i++ {
			if fref(assignment(i, nv)) {
				return true
			}
		}
		return false
	})
}

func TestSharing(t *testing.T) {
	m, err := NewManager(4)
	if err != nil {
		t.Fatal(err)
	}
	f1 := m.And(m.Var(0), m.Var(1))
	f2 := m.And(m.Var(0), m.Var(1))
	f3 := m.And(m.Var(1), m.Var(0)) // canonical: same node regardless of operand order
	if f1.n != f2.n || f1.n != f3.n {
		t.Fatal("structurally identical functions must share the same node")
	}
	before := m.NodeCount()
	g := m.And(m.Var(0), m.Var(1))
	if g.n != f1.n {
		t.Fatal("recomputing an existing function must reuse the shared node")
	}
	if m.NodeCount() != before {
		t.Fatal("unique table grew for an already existing function")
	}
}

func TestFreeKeepsLiveNodes(t *testing.T) {
	const nv = 4
	m, err := NewManager(nv)
	if err != nil {
		t.Fatal(err)
	}
	x0, x1, x2 := m.Var(0), m.Var(1), m.Var(2)
	f := m.And(x0, x1) // shared subfunction
	g := m.Or(f, x2)   // references f's nodes
	h := m.And(x0, x1) // same node as f

	gref := func(s []bool) bool { return (s[0] && s[1]) || s[2] }
	fref := func(s []bool) bool { return s[0] && s[1] }

	f.Free() // release one reference; g and h still need these nodes
	truthCheck(t, g, nv, gref)
	truthCheck(t, h, nv, fref)
	if _, ok := m.unique[uniqKey{v: h.n.v, low: h.n.low, high: h.n.high}]; !ok {
		t.Fatal("node still referenced by live handles was deleted")
	}

	// Once every handle is released, GC reclaims the nodes.
	h.Free()
	g.Free()
	x0.Free()
	x1.Free()
	x2.Free()
	m.GC()
	if m.NodeCount() != 0 {
		t.Fatalf("expected empty unique table after freeing all handles, got %d nodes", m.NodeCount())
	}
}

func TestReorder(t *testing.T) {
	const nv = 6
	m, err := NewManager(nv)
	if err != nil {
		t.Fatal(err)
	}
	x := func(i int) *Node { return m.Var(i) }

	type entry struct {
		h   *Node
		ref func(s []bool) bool
	}
	entries := []entry{
		{m.And(x(0), x(1)), func(s []bool) bool { return s[0] && s[1] }},
		{m.Or(m.And(x(0), x(2)), x(3)), func(s []bool) bool { return (s[0] && s[2]) || s[3] }},
		{m.Xor(x(1), m.Xor(x(4), x(5))), func(s []bool) bool { return s[1] != s[4] != s[5] }},
		{m.Ite(x(2), x(3), m.Not(x(4))), func(s []bool) bool {
			if s[2] {
				return s[3]
			}
			return !s[4]
		}},
		{m.Exists(m.And(x(0), x(5)), 5), func(s []bool) bool { return s[0] }},
	}
	for _, e := range entries {
		truthCheck(t, e.h, nv, e.ref)
	}

	// Reverse the variable order.
	perm := []int{5, 4, 3, 2, 1, 0}
	if err := m.Reorder(perm); err != nil {
		t.Fatal(err)
	}
	for i, v := range perm {
		if m.order[i] != v {
			t.Fatalf("order not updated: got %v", m.order)
		}
	}
	// Old handles must still denote the original functions.
	for i, e := range entries {
		t.Run(string(rune('A'+i)), func(t *testing.T) {
			truthCheck(t, e.h, nv, e.ref)
		})
	}

	// Operations created after the reorder must be correct too.
	g := m.And(entries[0].h, m.Or(x(5), x(4)))
	truthCheck(t, g, nv, func(s []bool) bool {
		return s[0] && s[1] && (s[5] || s[4])
	})

	// Canonicity under the new order.
	g2 := m.And(entries[0].h, m.Or(x(5), x(4)))
	if g.n != g2.n {
		t.Fatal("sharing broken after reorder")
	}

	// A second reorder back to identity keeps all functions intact.
	if err := m.Reorder([]int{0, 1, 2, 3, 4, 5}); err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		truthCheck(t, e.h, nv, e.ref)
	}
	truthCheck(t, g, nv, func(s []bool) bool { return s[0] && s[1] && (s[5] || s[4]) })
}

func TestReorderInvalid(t *testing.T) {
	m, err := NewManager(3)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range [][]int{
		{0, 1},       // wrong length
		{0, 1, 1},    // duplicate
		{0, 1, 3},    // out of range
		{0, 1, 2, 3}, // too long
	} {
		if err := m.Reorder(p); err == nil {
			t.Fatalf("Reorder(%v): expected error", p)
		}
	}
}

func TestSixteenVars(t *testing.T) {
	const nv = MaxVars
	m, err := NewManager(nv)
	if err != nil {
		t.Fatal(err)
	}
	// Parity over all 16 variables, checked against the full truth table.
	p := m.Var(0)
	for i := 1; i < nv; i++ {
		p = m.Xor(p, m.Var(i))
	}
	truthCheck(t, p, nv, func(s []bool) bool {
		par := false
		for _, b := range s {
			par = par != b
		}
		return par
	})

	// Conjunction over all 16 variables.
	q := m.Var(0)
	for i := 1; i < nv; i++ {
		q = m.And(q, m.Var(i))
	}
	truthCheck(t, q, nv, func(s []bool) bool {
		for _, b := range s {
			if !b {
				return false
			}
		}
		return true
	})

	// Quantify away 8 variables, verify exhaustively over the rest.
	r := m.Exists(p, 8, 9, 10, 11, 12, 13, 14, 15)
	truthCheck(t, r, nv, func(s []bool) bool {
		for bits := 0; bits < 1<<8; bits++ {
			s2 := append([]bool(nil), s...)
			par := false
			for i := 0; i < nv; i++ {
				v := s2[i]
				if i >= 8 {
					v = bits>>(i-8)&1 == 1
				}
				par = par != v
			}
			if par {
				return true
			}
		}
		return false
	})
}
