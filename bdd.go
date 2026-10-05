// Package bdd implements reduced ordered binary decision diagrams (ROBDDs)
// with normalized, shared nodes, Boolean operations, existential
// quantification, dynamic variable reordering, and reference-counted
// node management.
//
// A Manager supports at most MaxVars variables. Handles (Node values)
// keep denoting the same Boolean function across reordering. Nodes are
// reference counted: releasing a handle never deletes nodes that are
// still reachable from other live handles or from the unique table.
//
// A Manager is not safe for concurrent use.
package bdd

import "errors"

// MaxVars is the maximum number of variables a Manager supports.
const MaxVars = 16

// Node is a handle to a BDD node.
type Node uint32

// The two terminal nodes.
const (
	False Node = 0
	True  Node = 1
)

var (
	// ErrTooManyVars is returned when more than MaxVars variables are requested.
	ErrTooManyVars = errors.New("bdd: variable count exceeds MaxVars (16)")
	// ErrBadVar is reported when a variable index is out of range.
	ErrBadVar = errors.New("bdd: variable index out of range")
	// ErrBadPerm is returned by Reorder for a non-permutation argument.
	ErrBadPerm = errors.New("bdd: not a permutation of the variables")
)

type node struct {
	v     int  // variable index; numVars for terminals
	low   Node // cofactor for v = false
	high  Node // cofactor for v = true
	refs  uint32
	alive bool
}

type uniqueKey struct {
	v         int
	low, high Node
}

// Manager owns the unique node table, the variable ordering, and the
// reference counts of all nodes.
type Manager struct {
	numVars  int
	order    []int // order[level] = variable
	level    []int // level[variable] = level
	nodes    []node
	unique   map[uniqueKey]Node
	freelist []Node
}

// NewManager creates a Manager over numVars variables (0 <= numVars <= 16)
// with the identity variable order x0 < x1 < ... < x(numVars-1).
func NewManager(numVars int) (*Manager, error) {
	if numVars < 0 || numVars > MaxVars {
		return nil, ErrTooManyVars
	}
	m := &Manager{
		numVars: numVars,
		order:   make([]int, numVars),
		level:   make([]int, numVars),
		unique:  make(map[uniqueKey]Node),
	}
	for i := range m.order {
		m.order[i] = i
		m.level[i] = i
	}
	m.nodes = append(m.nodes,
		node{v: numVars, low: False, high: False, refs: 1, alive: true},
		node{v: numVars, low: True, high: True, refs: 1, alive: true},
	)
	return m, nil
}

// NumVars returns the number of variables of the Manager.
func (m *Manager) NumVars() int { return m.numVars }

// Order returns a copy of the current variable order: result[level] is the
// variable sitting at that level.
func (m *Manager) Order() []int {
	out := make([]int, m.numVars)
	copy(out, m.order)
	return out
}

// LevelOf returns the current level of variable v.
func (m *Manager) LevelOf(v int) int {
	if v < 0 || v >= m.numVars {
		panic(ErrBadVar)
	}
	return m.level[v]
}

// VarOf returns the variable of a node, or numVars for the terminals.
func (m *Manager) VarOf(f Node) int { return m.nodes[f].v }

// Low returns the cofactor of f for its top variable set to false.
func (m *Manager) Low(f Node) Node { return m.nodes[f].low }

// High returns the cofactor of f for its top variable set to true.
func (m *Manager) High(f Node) Node { return m.nodes[f].high }

// IsConst reports whether f is a terminal node.
func (m *Manager) IsConst(f Node) bool { return f == False || f == True }

// Valid reports whether f denotes a live node of this Manager.
func (m *Manager) Valid(f Node) bool {
	return int(f) < len(m.nodes) && m.nodes[f].alive
}

// RefCount returns the current reference count of f.
func (m *Manager) RefCount(f Node) uint32 { return m.nodes[f].refs }

// NodeCount returns the number of live non-terminal nodes.
func (m *Manager) NodeCount() int {
	count := 0
	for i := 2; i < len(m.nodes); i++ {
		if m.nodes[i].alive {
			count++
		}
	}
	return count
}

// mk is the canonical node constructor: it applies the reduction rule
// (low == high collapses) and the unique-table sharing rule.
func (m *Manager) mk(v int, low, high Node) Node {
	if low == high {
		return low
	}
	k := uniqueKey{v, low, high}
	if id, ok := m.unique[k]; ok {
		return id
	}
	var id Node
	if n := len(m.freelist); n > 0 {
		id = m.freelist[n-1]
		m.freelist = m.freelist[:n-1]
		m.nodes[id] = node{v: v, low: low, high: high, alive: true}
	} else {
		id = Node(len(m.nodes))
		m.nodes = append(m.nodes, node{v: v, low: low, high: high, alive: true})
	}
	m.unique[k] = id
	m.nodes[low].refs++
	m.nodes[high].refs++
	return id
}

// lvl returns the current level of the top variable of f; terminals sit
// below all variables.
func (m *Manager) lvl(f Node) int {
	v := m.nodes[f].v
	if v >= m.numVars {
		return m.numVars
	}
	return m.level[v]
}

// cofactor returns the cofactors of f with respect to v. A node not
// headed by v cofactors to itself.
func (m *Manager) cofactor(f Node, v int) (Node, Node) {
	n := &m.nodes[f]
	if n.v == v {
		return n.low, n.high
	}
	return f, f
}

// Ref increments the external reference count of f and returns f.
func (m *Manager) Ref(f Node) Node {
	m.nodes[f].refs++
	return f
}

// own marks a freshly computed result as externally referenced.
func (m *Manager) own(f Node) Node {
	m.nodes[f].refs++
	return f
}

// Release drops one external reference to f. Nodes whose count reaches
// zero are removed from the unique table and freed, recursively releasing
// their children; nodes still referenced by other live nodes or handles
// are never touched. A final sweep collects any unreachable zero-count
// nodes left over from earlier computations.
func (m *Manager) Release(f Node) {
	m.release(f)
	m.sweep()
}

func (m *Manager) release(f Node) {
	n := &m.nodes[f]
	if n.refs == 0 {
		return
	}
	n.refs--
	if n.refs == 0 && f != False && f != True {
		m.free(f)
	}
}

func (m *Manager) free(f Node) {
	n := &m.nodes[f]
	delete(m.unique, uniqueKey{n.v, n.low, n.high})
	low, high := n.low, n.high
	n.alive = false
	m.freelist = append(m.freelist, f)
	m.release(low)
	m.release(high)
}

func (m *Manager) sweep() {
	for {
		progress := false
		for id := Node(2); int(id) < len(m.nodes); id++ {
			if m.nodes[id].alive && m.nodes[id].refs == 0 {
				m.free(id)
				progress = true
			}
		}
		if !progress {
			return
		}
	}
}

// Var returns the BDD for the projection function of variable i.
func (m *Manager) Var(i int) Node {
	if i < 0 || i >= m.numVars {
		panic(ErrBadVar)
	}
	return m.own(m.mk(i, False, True))
}

// Eval evaluates f under the given assignment; assign must have at least
// NumVars entries.
func (m *Manager) Eval(f Node, assign []bool) bool {
	if len(assign) < m.numVars {
		panic(ErrBadVar)
	}
	for f != False && f != True {
		n := &m.nodes[f]
		if assign[n.v] {
			f = n.high
		} else {
			f = n.low
		}
	}
	return f == True
}

// TruthTable returns the full truth table of f over all NumVars variables:
// entry a is the value of f when variable i equals bit i of a.
func (m *Manager) TruthTable(f Node) []bool {
	n := m.numVars
	tt := make([]bool, 1<<uint(n))
	assign := make([]bool, n)
	for a := range tt {
		for i := 0; i < n; i++ {
			assign[i] = a>>uint(i)&1 == 1
		}
		tt[a] = m.Eval(f, assign)
	}
	return tt
}

// Support returns the sorted set of variables f depends on structurally.
func (m *Manager) Support(f Node) []int {
	seen := make(map[int]bool)
	visited := make(map[Node]bool)
	var walk func(f Node)
	walk = func(f Node) {
		if f == False || f == True || visited[f] {
			return
		}
		visited[f] = true
		seen[m.nodes[f].v] = true
		walk(m.nodes[f].low)
		walk(m.nodes[f].high)
	}
	walk(f)
	out := make([]int, 0, len(seen))
	for v := range seen {
		out = append(out, v)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1] > out[j]; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}
