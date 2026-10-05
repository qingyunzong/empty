// Package netflow maintains a directed graph with non-negative integer
// capacities. Edges are added and removed dynamically, updates can be
// undone, and after any sequence of updates the maximum flow and a
// minimum cut certificate can be computed. Parallel edges are supported
// and distinguished by their unique EdgeID.
package netflow

import "fmt"

// EdgeID uniquely identifies an edge, including parallel edges that
// share the same endpoints.
type EdgeID int

// Edge is a directed edge with a non-negative integer capacity.
type Edge struct {
	ID       EdgeID
	From, To int
	Cap      int
}

// Graph is a mutable directed multigraph with an undo log. Every
// mutating operation (AddEdge, RemoveEdge, Undo) advances the version.
type Graph struct {
	numVertices int
	edges       map[EdgeID]Edge
	nextID      EdgeID
	version     int
	log         []inverseOp
}

// inverseOp restores the state prior to a mutating operation.
type inverseOp struct {
	removeID EdgeID // if >= 0, delete this edge to undo
	restore  *Edge  // if non-nil, re-insert this edge to undo
}

// New returns a graph on vertices 0..numVertices-1.
func New(numVertices int) *Graph {
	if numVertices < 0 {
		panic("netflow: negative vertex count")
	}
	return &Graph{
		numVertices: numVertices,
		edges:       make(map[EdgeID]Edge),
	}
}

// NumVertices returns the number of vertices.
func (g *Graph) NumVertices() int { return g.numVertices }

// Version returns the current version. It increments on every
// AddEdge, RemoveEdge and successful Undo.
func (g *Graph) Version() int { return g.version }

// NumEdges returns the number of live edges.
func (g *Graph) NumEdges() int { return len(g.edges) }

// Edge returns the edge with the given ID.
func (g *Graph) Edge(id EdgeID) (Edge, bool) {
	e, ok := g.edges[id]
	return e, ok
}

// Edges returns a snapshot of all live edges.
func (g *Graph) Edges() []Edge {
	out := make([]Edge, 0, len(g.edges))
	for _, e := range g.edges {
		out = append(out, e)
	}
	return out
}

// AddEdge inserts a directed edge from->to with non-negative capacity
// and returns its unique ID. Parallel edges receive distinct IDs.
func (g *Graph) AddEdge(from, to, cap int) EdgeID {
	g.checkVertex(from)
	g.checkVertex(to)
	if cap < 0 {
		panic("netflow: negative capacity")
	}
	id := g.nextID
	g.nextID++
	g.edges[id] = Edge{ID: id, From: from, To: to, Cap: cap}
	g.log = append(g.log, inverseOp{removeID: id})
	g.version++
	return id
}

// RemoveEdge deletes the edge with the given ID. It reports whether
// the edge existed.
func (g *Graph) RemoveEdge(id EdgeID) bool {
	e, ok := g.edges[id]
	if !ok {
		return false
	}
	delete(g.edges, id)
	restore := e
	g.log = append(g.log, inverseOp{removeID: -1, restore: &restore})
	g.version++
	return true
}

// Undo reverts the most recent AddEdge or RemoveEdge. It reports
// whether there was an operation to undo.
func (g *Graph) Undo() bool {
	if len(g.log) == 0 {
		return false
	}
	op := g.log[len(g.log)-1]
	g.log = g.log[:len(g.log)-1]
	if op.restore != nil {
		g.edges[op.restore.ID] = *op.restore
	} else {
		delete(g.edges, op.removeID)
	}
	g.version++
	return true
}

func (g *Graph) checkVertex(v int) {
	if v < 0 || v >= g.numVertices {
		panic(fmt.Sprintf("netflow: vertex %d out of range [0,%d)", v, g.numVertices))
	}
}
