// Package bdd implements reduced ordered binary decision diagrams (ROBDDs)
// over at most 16 boolean variables.
//
// A Manager owns a unique table so structurally identical nodes are always
// shared (canonical representation under the current variable order).
// Handles (type Node) are reference counted: freeing a handle never deletes
// nodes that are still reachable from other live handles. Reorder changes
// the manager's variable order by rebuilding every live handle; existing
// handles keep denoting the same boolean function.
package bdd

import "fmt"

// MaxVars is the maximum number of boolean variables a Manager supports.
const MaxVars = 16

type node struct {
	v         int // variable index; -1 for terminals
	low, high *node
	refs      int // incoming DAG edges plus live handles
}

type uniqKey struct {
	v         int
	low, high *node
}

type op uint8

const (
	opAnd op = iota
	opOr
	opXor
	opNand
	opNor
	opImplies
)

type applyKey struct {
	o    op
	a, b *node
}

// Manager owns the unique table, the operation cache and the current
// variable order. It is not safe for concurrent use.
type Manager struct {
	numVars int
	order   []int // level -> variable
	pos     []int // variable -> level
	unique  map[uniqKey]*node
	cache   map[applyKey]*node
	zero    *node
	one     *node
	roots   map[*Node]struct{}
}

// Node is a handle to a BDD. The zero value is invalid; obtain handles from
// a Manager. A handle must be released with Free when no longer needed.
type Node struct {
	m *Manager
	n *node
}

// NewManager returns a Manager over numVars boolean variables with the
// identity variable order. numVars must be in [0, MaxVars].
func NewManager(numVars int) (*Manager, error) {
	if numVars < 0 || numVars > MaxVars {
		return nil, fmt.Errorf("bdd: numVars must be in [0, %d], got %d", MaxVars, numVars)
	}
	m := &Manager{
		numVars: numVars,
		order:   make([]int, numVars),
		pos:     make([]int, numVars),
		unique:  make(map[uniqKey]*node),
		cache:   make(map[applyKey]*node),
		zero:    &node{v: -1},
		one:     &node{v: -1},
		roots:   make(map[*Node]struct{}),
	}
	for i := range m.order {
		m.order[i] = i
		m.pos[i] = i
	}
	return m, nil
}

// NumVars returns the number of variables of the manager.
func (m *Manager) NumVars() int { return m.numVars }

// NodeCount returns the number of nodes currently in the unique table,
// including unreferenced nodes not yet reclaimed by GC.
func (m *Manager) NodeCount() int { return len(m.unique) }

func (m *Manager) checkVar(v int) {
	if v < 0 || v >= m.numVars {
		panic(fmt.Sprintf("bdd: variable index %d out of range [0, %d)", v, m.numVars))
	}
}

func (m *Manager) checkHandle(h *Node) {
	if h == nil || h.m != m || h.n == nil {
		panic("bdd: handle is nil, freed, or belongs to another manager")
	}
}

func (m *Manager) incref(n *node) {
	if n.v >= 0 {
		n.refs++
	}
}

// decref releases one reference. A node is removed from the unique table
// only when its last reference disappears; children that are still
// referenced by other parents or handles are never deleted.
func (m *Manager) decref(n *node) {
	if n.v < 0 {
		return
	}
	n.refs--
	if n.refs == 0 {
		delete(m.unique, uniqKey{n.v, n.low, n.high})
		m.decref(n.low)
		m.decref(n.high)
	}
}

// GC removes every unreferenced node from the unique table and clears the
// operation cache. Nodes reachable from live handles are kept.
func (m *Manager) GC() {
	m.cache = make(map[applyKey]*node)
	for {
		var dead []*node
		for _, n := range m.unique {
			if n.refs == 0 {
				dead = append(dead, n)
			}
		}
		if len(dead) == 0 {
			return
		}
		for _, n := range dead {
			if _, ok := m.unique[uniqKey{n.v, n.low, n.high}]; ok {
				m.decref(n)
			}
		}
	}
}

// mk is the only constructor for internal nodes: it enforces reduction
// (low == high collapses) and sharing through the unique table.
func (m *Manager) mk(v int, low, high *node) *node {
	if low == high {
		return low
	}
	k := uniqKey{v, low, high}
	if n, ok := m.unique[k]; ok {
		return n
	}
	n := &node{v: v, low: low, high: high}
	m.unique[k] = n
	m.incref(low)
	m.incref(high)
	return n
}

// handle registers n as a new external root and returns its handle.
func (m *Manager) handle(n *node) *Node {
	m.incref(n)
	h := &Node{m: m, n: n}
	m.roots[h] = struct{}{}
	return h
}

// Free releases the handle's reference. Nodes still reachable from other
// handles are kept; the handle must not be used afterwards.
func (n *Node) Free() {
	if n == nil || n.m == nil {
		return
	}
	delete(n.m.roots, n)
	n.m.decref(n.n)
	n.m = nil
	n.n = nil
}

// Const returns the constant function.
func (m *Manager) Const(v bool) *Node {
	if v {
		return m.handle(m.one)
	}
	return m.handle(m.zero)
}

// Var returns the projection function of variable i.
func (m *Manager) Var(i int) *Node {
	m.checkVar(i)
	return m.handle(m.mk(i, m.zero, m.one))
}

func applyOp(o op, a, b bool) bool {
	switch o {
	case opAnd:
		return a && b
	case opOr:
		return a || b
	case opXor:
		return a != b
	case opNand:
		return !(a && b)
	case opNor:
		return !(a || b)
	case opImplies:
		return !a || b
	}
	panic("bdd: unknown op")
}

func (m *Manager) boolNode(v bool) *node {
	if v {
		return m.one
	}
	return m.zero
}

// apply is the classic Shannon-expansion binary operation. All nodes in the
// unique table respect the current order, so a node not branching on the
// top variable is independent of it.
func (m *Manager) apply(o op, a, b *node) *node {
	if a.v < 0 && b.v < 0 {
		return m.boolNode(applyOp(o, a == m.one, b == m.one))
	}
	k := applyKey{o, a, b}
	if r, ok := m.cache[k]; ok {
		return r
	}
	var top int
	switch {
	case a.v < 0:
		top = b.v
	case b.v < 0:
		top = a.v
	case m.pos[a.v] <= m.pos[b.v]:
		top = a.v
	default:
		top = b.v
	}
	alo, ahi, blo, bhi := a, a, b, b
	if a.v == top {
		alo, ahi = a.low, a.high
	}
	if b.v == top {
		blo, bhi = b.low, b.high
	}
	r := m.mk(top, m.apply(o, alo, blo), m.apply(o, ahi, bhi))
	m.cache[k] = r
	return r
}

func (m *Manager) binop(o op, a, b *Node) *Node {
	m.checkHandle(a)
	m.checkHandle(b)
	return m.handle(m.apply(o, a.n, b.n))
}

// And returns a AND b.
func (m *Manager) And(a, b *Node) *Node { return m.binop(opAnd, a, b) }

// Or returns a OR b.
func (m *Manager) Or(a, b *Node) *Node { return m.binop(opOr, a, b) }

// Xor returns a XOR b.
func (m *Manager) Xor(a, b *Node) *Node { return m.binop(opXor, a, b) }

// Nand returns NOT (a AND b).
func (m *Manager) Nand(a, b *Node) *Node { return m.binop(opNand, a, b) }

// Nor returns NOT (a OR b).
func (m *Manager) Nor(a, b *Node) *Node { return m.binop(opNor, a, b) }

// Implies returns a IMPLIES b.
func (m *Manager) Implies(a, b *Node) *Node { return m.binop(opImplies, a, b) }

// Not returns the complement of h.
func (m *Manager) Not(h *Node) *Node {
	m.checkHandle(h)
	return m.handle(m.apply(opXor, h.n, m.one))
}

// Ite returns IF c THEN t ELSE e.
func (m *Manager) Ite(c, t, e *Node) *Node {
	m.checkHandle(c)
	m.checkHandle(t)
	m.checkHandle(e)
	// (c AND t) OR (NOT c AND e)
	ct := m.apply(opAnd, c.n, t.n)
	nc := m.apply(opXor, c.n, m.one)
	nce := m.apply(opAnd, nc, e.n)
	return m.handle(m.apply(opOr, ct, nce))
}

// Exists returns the existential quantification of h over the given
// variables: the result is true for an assignment iff h is true for some
// valuation of the quantified variables.
func (m *Manager) Exists(h *Node, vars ...int) *Node {
	m.checkHandle(h)
	set := make(map[int]bool, len(vars))
	for _, v := range vars {
		m.checkVar(v)
		set[v] = true
	}
	if len(set) == 0 {
		return m.handle(h.n)
	}
	memo := make(map[*node]*node)
	var rec func(n *node) *node
	rec = func(n *node) *node {
		if n.v < 0 {
			return n
		}
		if r, ok := memo[n]; ok {
			return r
		}
		lo, hi := rec(n.low), rec(n.high)
		var r *node
		if set[n.v] {
			r = m.apply(opOr, lo, hi)
		} else {
			r = m.mk(n.v, lo, hi)
		}
		memo[n] = r
		return r
	}
	return m.handle(rec(h.n))
}

// Reorder sets a new variable order: perm[level] is the variable placed at
// that level, so perm must be a permutation of 0..numVars-1. Every live
// handle is rebuilt under the new order and keeps denoting exactly the same
// boolean function; stale nodes from the old order are reclaimed.
func (m *Manager) Reorder(perm []int) error {
	if len(perm) != m.numVars {
		return fmt.Errorf("bdd: permutation length %d, want %d", len(perm), m.numVars)
	}
	seen := make([]bool, m.numVars)
	for _, v := range perm {
		if v < 0 || v >= m.numVars || seen[v] {
			return fmt.Errorf("bdd: %v is not a permutation of 0..%d", perm, m.numVars-1)
		}
		seen[v] = true
	}
	m.order = append([]int(nil), perm...)
	for lvl, v := range m.order {
		m.pos[v] = lvl
	}
	type swap struct {
		h  *Node
		nn *node
	}
	swaps := make([]swap, 0, len(m.roots))
	for h := range m.roots {
		nn := m.rebuild(h.n)
		m.incref(nn)
		swaps = append(swaps, swap{h, nn})
	}
	for _, s := range swaps {
		m.decref(s.h.n)
		s.h.n = s.nn
	}
	m.GC() // drop old-order nodes and stale cache entries
	return nil
}

// rebuild re-derives the function denoted by old as a canonical BDD under
// the current order by exhaustive Shannon expansion (numVars <= 16).
func (m *Manager) rebuild(old *node) *node {
	assign := make([]bool, m.numVars)
	var rec func(level int) *node
	rec = func(level int) *node {
		if level == m.numVars {
			return m.boolNode(eval(old, assign, m.one))
		}
		v := m.order[level]
		assign[v] = false
		lo := rec(level + 1)
		assign[v] = true
		hi := rec(level + 1)
		assign[v] = false
		return m.mk(v, lo, hi)
	}
	return rec(0)
}

func eval(n *node, assign []bool, one *node) bool {
	for n.v >= 0 {
		if assign[n.v] {
			n = n.high
		} else {
			n = n.low
		}
	}
	return n == one
}

// Eval evaluates the function under a full assignment; assign[i] is the
// value of variable i and len(assign) must be at least NumVars().
func (n *Node) Eval(assign []bool) bool {
	if n == nil || n.m == nil {
		panic("bdd: Eval on nil or freed handle")
	}
	return eval(n.n, assign, n.m.one)
}
