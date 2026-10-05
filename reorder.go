package bdd

// Reorder installs perm as the new variable order: perm[level] is the
// variable at that level. Existing handles are untouched and keep
// denoting the same Boolean functions; new nodes are built under the
// new order. Use Rebuild to re-canonicalize a handle under the new
// order (typically to shrink it).
func (m *Manager) Reorder(perm []int) error {
	if len(perm) != m.numVars {
		return ErrBadPerm
	}
	seen := make([]bool, m.numVars)
	for _, v := range perm {
		if v < 0 || v >= m.numVars || seen[v] {
			return ErrBadPerm
		}
		seen[v] = true
	}
	copy(m.order, perm)
	for lvl, v := range perm {
		m.level[v] = lvl
	}
	return nil
}

// SwapAdjacent swaps the variables at levels lvl and lvl+1, the
// elementary step of dynamic reordering. Existing handles keep denoting
// the same functions.
func (m *Manager) SwapAdjacent(lvl int) error {
	if lvl < 0 || lvl+1 >= m.numVars {
		return ErrBadVar
	}
	m.order[lvl], m.order[lvl+1] = m.order[lvl+1], m.order[lvl]
	m.level[m.order[lvl]] = lvl
	m.level[m.order[lvl+1]] = lvl + 1
	return nil
}

// Rebuild returns a canonical representation of f under the current
// variable order, computed by Shannon expansion along the order. The
// input handle is not modified.
func (m *Manager) Rebuild(f Node) Node {
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
		r := m.mk(v,
			rec(lvl+1, m.restrict(f, v, false, rc)),
			rec(lvl+1, m.restrict(f, v, true, rc)),
		)
		cache[k] = r
		return r
	}
	return m.own(rec(0, f))
}

type restrictKey struct {
	f   Node
	v   int
	val bool
}

type restrictCache map[restrictKey]Node

// restrict substitutes the constant val for every occurrence of v in f.
// It is a purely semantic substitution and stays correct for nodes that
// do not follow the current variable order.
func (m *Manager) restrict(f Node, v int, val bool, cache restrictCache) Node {
	var rec func(f Node) Node
	rec = func(f Node) Node {
		if f == False || f == True {
			return f
		}
		n := m.nodes[f]
		if n.v == v {
			// Recurse: on non-canonical nodes v may occur again
			// further down the same path.
			if val {
				return rec(n.high)
			}
			return rec(n.low)
		}
		k := restrictKey{f, v, val}
		if r, ok := cache[k]; ok {
			return r
		}
		r := m.mk(n.v, rec(n.low), rec(n.high))
		cache[k] = r
		return r
	}
	return rec(f)
}
