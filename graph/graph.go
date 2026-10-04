// Package graph implements a versioned undirected bipartite graph with
// edge insertion, deletion and undo. Vertices are identified by stable
// string IDs: isolated vertices are preserved, and duplicate edge
// insertions are idempotent no-ops.
package graph

import (
	"errors"
	"sort"
)

// ErrNotBipartite is returned when an edge insertion would make the
// graph non-bipartite. Maximum matching and minimum vertex cover are
// guaranteed to have equal size only on bipartite graphs (Kőnig's
// theorem), so such edges are rejected.
var ErrNotBipartite = errors.New("graph: edge would violate bipartiteness")

// ErrSelfLoop is returned when an edge connects a vertex to itself.
var ErrSelfLoop = errors.New("graph: self-loops are not allowed")

// Edge is an undirected edge between two stable vertex IDs.
type Edge struct {
	U, V string
}

type mutationKind int

const (
	mutAdd mutationKind = iota
	mutRemove
)

type mutation struct {
	kind mutationKind
	u, v string
}

// Graph is a versioned bipartite graph. Every successful mutation
// (including Undo) bumps the version; analyses are cached per version.
type Graph struct {
	adj      map[string]map[string]struct{}
	log      []mutation
	version  int
	cache    *Analysis
	cacheVer int
}

// New returns an empty graph.
func New() *Graph {
	return &Graph{adj: make(map[string]map[string]struct{}), cacheVer: -1}
}

// Version returns the current version. It starts at 0 and increases by
// one for every applied mutation, including undos.
func (g *Graph) Version() int { return g.version }

// AddVertex registers an isolated vertex with the given stable ID.
// It is idempotent and does not create a new version.
func (g *Graph) AddVertex(id string) {
	if _, ok := g.adj[id]; !ok {
		g.adj[id] = make(map[string]struct{})
	}
}

// Has reports whether the edge {u, v} exists.
func (g *Graph) Has(u, v string) bool {
	_, ok := g.adj[u][v]
	return ok
}

// AddEdge inserts the edge {u, v}, creating endpoint vertices as
// needed. Duplicate insertions are idempotent no-ops that return the
// current version. It returns ErrSelfLoop or ErrNotBipartite (leaving
// the graph unchanged) for invalid edges.
func (g *Graph) AddEdge(u, v string) (int, error) {
	if u == v {
		return g.version, ErrSelfLoop
	}
	if g.Has(u, v) {
		return g.version, nil
	}
	if err := g.checkBipartite(u, v); err != nil {
		return g.version, err
	}
	g.addEdge(u, v)
	g.log = append(g.log, mutation{kind: mutAdd, u: u, v: v})
	g.version++
	return g.version, nil
}

// RemoveEdge deletes the edge {u, v}. It reports false and leaves the
// version unchanged if the edge does not exist. Endpoint vertices are
// kept, so they may become isolated.
func (g *Graph) RemoveEdge(u, v string) (int, bool) {
	if !g.Has(u, v) {
		return g.version, false
	}
	g.removeEdge(u, v)
	g.log = append(g.log, mutation{kind: mutRemove, u: u, v: v})
	g.version++
	return g.version, true
}

// Undo reverts the most recent edge insertion or deletion. It reports
// false if there is nothing to undo. Undo itself is a mutation and
// bumps the version.
func (g *Graph) Undo() (int, bool) {
	if len(g.log) == 0 {
		return g.version, false
	}
	m := g.log[len(g.log)-1]
	g.log = g.log[:len(g.log)-1]
	if m.kind == mutAdd {
		g.removeEdge(m.u, m.v)
	} else {
		g.addEdge(m.u, m.v)
	}
	g.version++
	return g.version, true
}

// Vertices returns all vertex IDs (including isolated ones) in sorted
// order.
func (g *Graph) Vertices() []string {
	vs := make([]string, 0, len(g.adj))
	for id := range g.adj {
		vs = append(vs, id)
	}
	sort.Strings(vs)
	return vs
}

// Edges returns all edges in deterministic sorted order.
func (g *Graph) Edges() []Edge {
	var es []Edge
	for u, nbrs := range g.adj {
		for v := range nbrs {
			if u < v {
				es = append(es, Edge{U: u, V: v})
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

func (g *Graph) addEdge(u, v string) {
	g.AddVertex(u)
	g.AddVertex(v)
	g.adj[u][v] = struct{}{}
	g.adj[v][u] = struct{}{}
}

func (g *Graph) removeEdge(u, v string) {
	delete(g.adj[u], v)
	delete(g.adj[v], u)
}

// checkBipartite reports whether adding {u, v} keeps the graph
// bipartite. Only edges whose endpoints already lie in the same
// connected component can violate bipartiteness.
func (g *Graph) checkBipartite(u, v string) error {
	_, uOK := g.adj[u]
	_, vOK := g.adj[v]
	if !uOK || !vOK {
		return nil
	}
	color := map[string]int{u: 0}
	queue := []string{u}
	for len(queue) > 0 {
		x := queue[0]
		queue = queue[1:]
		if x == v {
			if color[x] == color[u] {
				return ErrNotBipartite
			}
			return nil
		}
		for y := range g.adj[x] {
			if _, seen := color[y]; !seen {
				color[y] = color[x] ^ 1
				queue = append(queue, y)
			}
		}
	}
	return nil
}
