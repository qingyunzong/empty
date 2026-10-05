// Package parity maintains equality/opposite (XOR parity) constraints
// between nodes, with savepoints, batch undo, and odd-cycle conflict
// reporting.
//
// The data structure is a weighted union-find with rollback: it unions by
// size only and never performs path compression, so every merge can be
// undone exactly by replaying a journal in reverse.
package parity

import "fmt"

// Edge is a single constraint: value(X) XOR value(Y) == W, with W in {0,1}.
// W == 0 means "equal", W == 1 means "opposite".
type Edge struct {
	X, Y, W int
}

// Conflict describes a rejected constraint. Edges is the odd-parity
// contradiction cycle composed of original constraint edges: previously
// accepted edges followed by the rejected edge itself as the last element.
// The XOR of all W values in Edges is 1.
type Conflict struct {
	Edges []Edge
}

func (c *Conflict) Error() string {
	return fmt.Sprintf("parity: contradictory constraint (odd cycle of %d edges)", len(c.Edges))
}

// undoEntry records one merge so it can be reverted exactly.
type undoEntry struct {
	child     int // root that was attached
	parent    int // root it was attached to
	edgeIndex int // index in uf.edges of the original edge used for the merge
	prevSize  int // size of the parent root before the merge
}

// UF is a rollback-aware union-find tracking XOR parity between nodes.
type UF struct {
	parent  []int
	xor     []int  // parity from node to its parent (meaningless for roots)
	size    []int  // subtree size, meaningful for roots only
	edges   []Edge // original edges that became forest edges
	journal []undoEntry
}

// New returns a UF with n isolated nodes numbered 0..n-1.
func New(n int) *UF {
	u := &UF{
		parent: make([]int, n),
		xor:    make([]int, n),
		size:   make([]int, n),
	}
	for i := range u.parent {
		u.parent[i] = i
		u.size[i] = 1
	}
	return u
}

// Add appends a fresh isolated node and returns its id.
// Node creation is not undone by Rollback or Undo.
func (u *UF) Add() int {
	id := len(u.parent)
	u.parent = append(u.parent, id)
	u.xor = append(u.xor, 0)
	u.size = append(u.size, 1)
	return id
}

// Len returns the number of nodes.
func (u *UF) Len() int { return len(u.parent) }

func (u *UF) check(x int) {
	if x < 0 || x >= len(u.parent) {
		panic(fmt.Sprintf("parity: node %d out of range [0,%d)", x, len(u.parent)))
	}
}

// find walks to the root without path compression, accumulating parity.
func (u *UF) find(x int) (root, parity int) {
	p := 0
	for u.parent[x] != x {
		p ^= u.xor[x]
		x = u.parent[x]
	}
	return x, p
}

// Union adds the constraint value(x) XOR value(y) == w.
//
// It returns nil if the constraint is consistent (already implied or newly
// merged). Otherwise it returns a *Conflict whose Edges form the odd-parity
// contradiction cycle; the UF is left unchanged in that case.
func (u *UF) Union(x, y, w int) *Conflict {
	u.check(x)
	u.check(y)
	rx, px := u.find(x)
	ry, py := u.find(y)
	if rx == ry {
		if px^py == w {
			return nil
		}
		return &Conflict{Edges: u.cycleEdges(x, y, w)}
	}
	if u.size[rx] > u.size[ry] {
		rx, ry = ry, rx
		px, py = py, px
	}
	u.parent[rx] = ry
	u.xor[rx] = px ^ py ^ w
	u.edges = append(u.edges, Edge{X: x, Y: y, W: w})
	u.journal = append(u.journal, undoEntry{
		child:     rx,
		parent:    ry,
		edgeIndex: len(u.edges) - 1,
		prevSize:  u.size[ry],
	})
	u.size[ry] += u.size[rx]
	return nil
}

// cycleEdges builds the contradiction cycle for the rejected edge (x,y,w).
//
// The original edges in u.edges form a spanning forest of the constraint
// graph (one edge per merge, connecting the two merged components), so
// there is a unique path of original edges from x to y; appending the
// rejected edge closes an odd-parity cycle.
func (u *UF) cycleEdges(x, y, w int) []Edge {
	adj := make(map[int][]int, len(u.parent))
	for i, e := range u.edges {
		adj[e.X] = append(adj[e.X], i)
		adj[e.Y] = append(adj[e.Y], i)
	}
	prevNode := map[int]int{x: -1}
	prevEdge := map[int]int{x: -1}
	stack := []int{x}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if cur == y {
			break
		}
		for _, ei := range adj[cur] {
			e := u.edges[ei]
			next := e.X
			if next == cur {
				next = e.Y
			}
			if _, seen := prevNode[next]; !seen {
				prevNode[next] = cur
				prevEdge[next] = ei
				stack = append(stack, next)
			}
		}
	}
	var path []Edge
	for cur := y; cur != x; cur = prevNode[cur] {
		path = append(path, u.edges[prevEdge[cur]])
	}
	cycle := make([]Edge, 0, len(path)+1)
	for i := len(path) - 1; i >= 0; i-- {
		cycle = append(cycle, path[i])
	}
	cycle = append(cycle, Edge{X: x, Y: y, W: w})
	return cycle
}

// Query reports the parity between x and y. ok is false if they are not
// connected by any constraints.
func (u *UF) Query(x, y int) (parity int, ok bool) {
	u.check(x)
	u.check(y)
	rx, px := u.find(x)
	ry, py := u.find(y)
	if rx != ry {
		return 0, false
	}
	return px ^ py, true
}

// Savepoint returns a token identifying the current version.
func (u *UF) Savepoint() int { return len(u.journal) }

// Rollback undoes every merge recorded after the given savepoint,
// restoring the exact prior state.
func (u *UF) Rollback(sp int) {
	if sp < 0 || sp > len(u.journal) {
		panic(fmt.Sprintf("parity: savepoint %d out of range [0,%d]", sp, len(u.journal)))
	}
	for len(u.journal) > sp {
		u.undoOne()
	}
}

// Undo reverts the last n merges (batch undo) and returns how many were
// actually reverted (fewer than n if the journal is shorter).
func (u *UF) Undo(n int) int {
	done := 0
	for ; n > 0 && len(u.journal) > 0; n-- {
		u.undoOne()
		done++
	}
	return done
}

func (u *UF) undoOne() {
	e := u.journal[len(u.journal)-1]
	u.journal = u.journal[:len(u.journal)-1]
	u.parent[e.child] = e.child
	u.xor[e.child] = 0
	u.size[e.parent] = e.prevSize
	u.edges = u.edges[:e.edgeIndex]
}
