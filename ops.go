package bdd

// Not returns the negation of f.
func (m *Manager) Not(f Node) Node { return m.own(m.not(f)) }

func (m *Manager) not(f Node) Node {
	cache := make(map[Node]Node)
	var rec func(f Node) Node
	rec = func(f Node) Node {
		if f == False {
			return True
		}
		if f == True {
			return False
		}
		if r, ok := cache[f]; ok {
			return r
		}
		n := m.nodes[f]
		r := m.mk(n.v, rec(n.low), rec(n.high))
		cache[f] = r
		return r
	}
	return rec(f)
}

// And returns the conjunction of f and g.
func (m *Manager) And(f, g Node) Node { return m.own(m.and(f, g)) }

// Or returns the disjunction of f and g.
func (m *Manager) Or(f, g Node) Node { return m.own(m.or(f, g)) }

// Xor returns the exclusive disjunction of f and g.
func (m *Manager) Xor(f, g Node) Node { return m.own(m.ite(f, m.not(g), g)) }

// Imply returns f implies g.
func (m *Manager) Imply(f, g Node) Node { return m.own(m.ite(f, g, True)) }

// Equiv returns the equivalence of f and g.
func (m *Manager) Equiv(f, g Node) Node { return m.own(m.not(m.ite(f, m.not(g), g))) }

// Ite returns "if i then t else e".
func (m *Manager) Ite(i, t, e Node) Node { return m.own(m.ite(i, t, e)) }

func (m *Manager) and(f, g Node) Node { return m.ite(f, g, False) }
func (m *Manager) or(f, g Node) Node  { return m.ite(f, True, g) }

type iteKey struct{ i, t, e Node }

func (m *Manager) ite(i, t, e Node) Node {
	cache := make(map[iteKey]Node)
	return m.iteRec(i, t, e, cache)
}

// iteRec is the classical ITE algorithm. Cofactoring a node whose top
// variable differs from the recursion variable yields the node itself,
// which stays correct even for nodes built under a previous variable
// order: the misplaced branch is only read under assignments where the
// two cofactors agree.
func (m *Manager) iteRec(i, t, e Node, cache map[iteKey]Node) Node {
	if i == True {
		return t
	}
	if i == False {
		return e
	}
	if t == e {
		return t
	}
	if t == True && e == False {
		return i
	}
	k := iteKey{i, t, e}
	if r, ok := cache[k]; ok {
		return r
	}
	v := m.topVar(i, t, e)
	i0, i1 := m.cofactor(i, v)
	t0, t1 := m.cofactor(t, v)
	e0, e1 := m.cofactor(e, v)
	r := m.mk(v,
		m.iteRec(i0, t0, e0, cache),
		m.iteRec(i1, t1, e1, cache),
	)
	cache[k] = r
	return r
}

// topVar returns the variable closest to the root among the top
// variables of the arguments.
func (m *Manager) topVar(args ...Node) int {
	best, bestLvl := -1, m.numVars+1
	for _, f := range args {
		if v := m.nodes[f].v; v < m.numVars && m.level[v] < bestLvl {
			best, bestLvl = v, m.level[v]
		}
	}
	return best
}

// Exists returns the existential quantification of f over vars.
func (m *Manager) Exists(f Node, vars ...int) Node {
	return m.quantify(f, vars, true)
}

// ForAll returns the universal quantification of f over vars.
func (m *Manager) ForAll(f Node, vars ...int) Node {
	return m.quantify(f, vars, false)
}

// quantify eliminates vars by Shannon expansion along the current
// variable order, using semantic substitution (restrict) for cofactors.
// Unlike a purely structural recursion this stays correct for nodes
// built under a previous variable order, where a quantified variable
// may occur more than once along a path.
func (m *Manager) quantify(f Node, vars []int, existential bool) Node {
	if len(vars) == 0 {
		return m.own(f)
	}
	inSet := make([]bool, m.numVars)
	for _, v := range vars {
		if v < 0 || v >= m.numVars {
			panic(ErrBadVar)
		}
		inSet[v] = true
	}
	rc := make(restrictCache)
	type key struct {
		lvl int
		f   Node
	}
	cache := make(map[key]Node)
	var rec func(lvl int, f Node) Node
	rec = func(lvl int, f Node) Node {
		if f == False || f == True {
			return f
		}
		k := key{lvl, f}
		if r, ok := cache[k]; ok {
			return r
		}
		v := m.order[lvl]
		low := rec(lvl+1, m.restrict(f, v, false, rc))
		high := rec(lvl+1, m.restrict(f, v, true, rc))
		var r Node
		switch {
		case inSet[v] && existential:
			r = m.or(low, high)
		case inSet[v]:
			r = m.and(low, high)
		default:
			r = m.mk(v, low, high)
		}
		cache[k] = r
		return r
	}
	return m.own(rec(0, f))
}
