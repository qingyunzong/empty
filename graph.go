// Package graphtest provides transformations on integer graphs
// (relabeling, irrelevant-vertex addition, edge splitting) together with
// recorded transformation chains and an independent verifier.
package graphtest

import (
	"fmt"
	"sort"
)

// Graph is an undirected simple graph on integer vertices.
type Graph struct {
	adj map[int]map[int]struct{}
}

// NewGraph returns an empty graph.
func NewGraph() *Graph {
	return &Graph{adj: make(map[int]map[int]struct{})}
}

// AddVertex inserts v if absent.
func (g *Graph) AddVertex(v int) {
	if _, ok := g.adj[v]; !ok {
		g.adj[v] = make(map[int]struct{})
	}
}

// AddEdge inserts the undirected edge (u, v), creating endpoints as needed.
// Self-loops are rejected.
func (g *Graph) AddEdge(u, v int) error {
	if u == v {
		return fmt.Errorf("graphtest: self-loop (%d,%d) is not allowed", u, v)
	}
	g.AddVertex(u)
	g.AddVertex(v)
	g.adj[u][v] = struct{}{}
	g.adj[v][u] = struct{}{}
	return nil
}

// HasVertex reports whether v exists.
func (g *Graph) HasVertex(v int) bool {
	_, ok := g.adj[v]
	return ok
}

// HasEdge reports whether edge (u, v) exists.
func (g *Graph) HasEdge(u, v int) bool {
	nb, ok := g.adj[u]
	if !ok {
		return false
	}
	_, ok = nb[v]
	return ok
}

// NumVertices returns the vertex count.
func (g *Graph) NumVertices() int { return len(g.adj) }

// NumEdges returns the edge count.
func (g *Graph) NumEdges() int {
	n := 0
	for _, nb := range g.adj {
		n += len(nb)
	}
	return n / 2
}

// Vertices returns the sorted vertex list.
func (g *Graph) Vertices() []int {
	vs := make([]int, 0, len(g.adj))
	for v := range g.adj {
		vs = append(vs, v)
	}
	sort.Ints(vs)
	return vs
}

// Edge is a canonical undirected edge with U < V.
type Edge struct {
	U, V int
}

// Edges returns the sorted list of canonical edges.
func (g *Graph) Edges() []Edge {
	var es []Edge
	for u, nb := range g.adj {
		for v := range nb {
			if u < v {
				es = append(es, Edge{u, v})
			}
		}
	}
	sort.Slice(es, func(i, j int) bool {
		if es[i].U != es[j].U {
			return es[i].U < es[j].U
		}
		return es[i].V < es[j].V
	})
	return es
}

// Neighbors returns the sorted neighbors of v.
func (g *Graph) Neighbors(v int) []int {
	nb := g.adj[v]
	out := make([]int, 0, len(nb))
	for u := range nb {
		out = append(out, u)
	}
	sort.Ints(out)
	return out
}

// Clone returns a deep copy.
func (g *Graph) Clone() *Graph {
	h := NewGraph()
	for v, nb := range g.adj {
		h.adj[v] = make(map[int]struct{}, len(nb))
		for u := range nb {
			h.adj[v][u] = struct{}{}
		}
	}
	return h
}

// Equal reports whether g and h have identical vertices and edges.
func (g *Graph) Equal(h *Graph) bool {
	if len(g.adj) != len(h.adj) {
		return false
	}
	for v, nb := range g.adj {
		onb, ok := h.adj[v]
		if !ok || len(nb) != len(onb) {
			return false
		}
		for u := range nb {
			if _, ok := onb[u]; !ok {
				return false
			}
		}
	}
	return true
}
