// Package graphtransform implements transformations on integer graphs
// (relabeling, isolated-vertex addition, edge subdivision) together with
// public result mappings, certificates recording the random seed and the
// transformation chain, and an independent verifier that replays the chain
// and checks the inverse mapping.
package graphtransform

import (
	"fmt"
	"sort"
	"strings"
)

// Edge is an undirected edge between two integer vertices, stored in
// canonical order (U < V).
type Edge struct{ U, V int }

// NewEdge returns the canonical form of the edge between u and v.
func NewEdge(u, v int) Edge {
	if u > v {
		u, v = v, u
	}
	return Edge{u, v}
}

// Graph is an undirected simple graph on integer vertices.
type Graph struct {
	adj map[int]map[int]struct{}
}

// NewGraph returns an empty graph.
func NewGraph() *Graph {
	return &Graph{adj: make(map[int]map[int]struct{})}
}

// AddVertex inserts v if not already present.
func (g *Graph) AddVertex(v int) {
	if _, ok := g.adj[v]; !ok {
		g.adj[v] = make(map[int]struct{})
	}
}

// AddEdge inserts the edge u-v, creating endpoints as needed.
func (g *Graph) AddEdge(u, v int) {
	if u == v {
		return
	}
	g.AddVertex(u)
	g.AddVertex(v)
	g.adj[u][v] = struct{}{}
	g.adj[v][u] = struct{}{}
}

// RemoveEdge deletes the edge u-v if present; vertices are kept.
func (g *Graph) RemoveEdge(u, v int) {
	delete(g.adj[u], v)
	delete(g.adj[v], u)
}

// RemoveVertex deletes v and all incident edges.
func (g *Graph) RemoveVertex(v int) {
	for w := range g.adj[v] {
		delete(g.adj[w], v)
	}
	delete(g.adj, v)
}

// HasVertex reports whether v exists.
func (g *Graph) HasVertex(v int) bool {
	_, ok := g.adj[v]
	return ok
}

// HasEdge reports whether the edge u-v exists.
func (g *Graph) HasEdge(u, v int) bool {
	_, ok := g.adj[u][v]
	return ok
}

// Degree returns the number of neighbors of v (0 if absent).
func (g *Graph) Degree(v int) int {
	return len(g.adj[v])
}

// Neighbors returns the sorted neighbors of v.
func (g *Graph) Neighbors(v int) []int {
	out := make([]int, 0, len(g.adj[v]))
	for w := range g.adj[v] {
		out = append(out, w)
	}
	sort.Ints(out)
	return out
}

// Vertices returns the sorted vertex list.
func (g *Graph) Vertices() []int {
	out := make([]int, 0, len(g.adj))
	for v := range g.adj {
		out = append(out, v)
	}
	sort.Ints(out)
	return out
}

// Edges returns the sorted canonical edge list.
func (g *Graph) Edges() []Edge {
	out := make([]Edge, 0)
	for u, nbrs := range g.adj {
		for v := range nbrs {
			if u < v {
				out = append(out, Edge{u, v})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].U != out[j].U {
			return out[i].U < out[j].U
		}
		return out[i].V < out[j].V
	})
	return out
}

// Clone returns a deep copy.
func (g *Graph) Clone() *Graph {
	h := NewGraph()
	for v, nbrs := range g.adj {
		h.adj[v] = make(map[int]struct{}, len(nbrs))
		for w := range nbrs {
			h.adj[v][w] = struct{}{}
		}
	}
	return h
}

// Equal reports whether g and o have identical vertices and edges.
func (g *Graph) Equal(o *Graph) bool {
	if len(g.adj) != len(o.adj) {
		return false
	}
	for v, nbrs := range g.adj {
		on, ok := o.adj[v]
		if !ok || len(nbrs) != len(on) {
			return false
		}
		for w := range nbrs {
			if _, ok := on[w]; !ok {
				return false
			}
		}
	}
	return true
}

func (g *Graph) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "V=%v E=%v", g.Vertices(), g.Edges())
	return b.String()
}
