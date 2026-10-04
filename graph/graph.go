// Package graph provides a versioned bipartite graph supporting edge
// insertion, deletion and undo. Every version can be analyzed to obtain
// a maximum matching together with a minimum vertex cover of the same
// size (Konig's theorem). Vertices use stable caller-provided string
// IDs; isolated vertices are retained and duplicate edges collapse to
// a single edge.
package graph

import "sort"

// Side identifies which part of the bipartition a vertex belongs to.
type Side int

const (
	Left Side = iota
	Right
)

// Edge is an undirected edge between Left vertex L and Right vertex R.
type Edge struct {
	L string
	R string
}

// operation is one undoable edge mutation.
type operation struct {
	insert bool
	edge   Edge
}

// Graph is a bipartite graph with stable string vertex IDs.
type Graph struct {
	left    map[string]struct{}
	right   map[string]struct{}
	adj     map[string]map[string]struct{} // left ID -> set of right IDs
	version int
	history []operation
}

// New returns an empty graph.
func New() *Graph {
	return &Graph{
		left:  make(map[string]struct{}),
		right: make(map[string]struct{}),
		adj:   make(map[string]map[string]struct{}),
	}
}

// Version returns the current version. Every state-changing edge
// operation, including Undo, advances the version by one.
func (g *Graph) Version() int { return g.version }

func (g *Graph) setFor(side Side) map[string]struct{} {
	if side == Right {
		return g.right
	}
	return g.left
}

// AddVertex registers id on the given side so isolated vertices are
// tracked. It is idempotent and does not create a new version.
func (g *Graph) AddVertex(side Side, id string) {
	g.setFor(side)[id] = struct{}{}
	if side == Left {
		if _, ok := g.adj[id]; !ok {
			g.adj[id] = make(map[string]struct{})
		}
	}
}

// AddEdge inserts edge (l, r), registering endpoints as needed. It
// reports whether the graph changed; adding a duplicate edge is a no-op
// and creates neither a version nor an undo record.
func (g *Graph) AddEdge(l, r string) bool {
	g.AddVertex(Left, l)
	g.AddVertex(Right, r)
	if _, ok := g.adj[l][r]; ok {
		return false
	}
	g.adj[l][r] = struct{}{}
	g.history = append(g.history, operation{insert: true, edge: Edge{L: l, R: r}})
	g.version++
	return true
}

// RemoveEdge deletes edge (l, r). It reports whether the edge existed;
// removing a missing edge is a no-op and creates neither a version nor
// an undo record. Endpoints remain registered, so they may become
// isolated vertices.
func (g *Graph) RemoveEdge(l, r string) bool {
	if _, ok := g.adj[l][r]; !ok {
		return false
	}
	delete(g.adj[l], r)
	g.history = append(g.history, operation{insert: false, edge: Edge{L: l, R: r}})
	g.version++
	return true
}

// Undo reverts the most recent state-changing edge operation and
// reports whether there was anything to revert.
func (g *Graph) Undo() bool {
	n := len(g.history)
	if n == 0 {
		return false
	}
	op := g.history[n-1]
	g.history = g.history[:n-1]
	if op.insert {
		delete(g.adj[op.edge.L], op.edge.R)
	} else {
		g.adj[op.edge.L][op.edge.R] = struct{}{}
	}
	g.version++
	return true
}

// Vertices returns the sorted stable IDs registered on the given side,
// including isolated vertices.
func (g *Graph) Vertices(side Side) []string {
	set := g.setFor(side)
	out := make([]string, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// Edges returns the sorted edge set of the current version.
func (g *Graph) Edges() []Edge {
	var out []Edge
	for l, rs := range g.adj {
		for r := range rs {
			out = append(out, Edge{L: l, R: r})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].L != out[j].L {
			return out[i].L < out[j].L
		}
		return out[i].R < out[j].R
	})
	return out
}
