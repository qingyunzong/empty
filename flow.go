// Package flow maintains a directed graph whose edges carry non-negative
// integer capacities. Edges can be added, removed, and updates can be
// undone in LIFO order. At any version the package computes the maximum
// flow between two vertices together with a minimum-cut certificate.
//
// Parallel edges are allowed and are distinguished by their unique IDs.
package flow

import (
	"errors"
	"fmt"
	"sort"
)

// Edge is a directed edge with a non-negative integer capacity.
type Edge struct {
	ID       string
	From, To int
	Cap      int64
}

// ErrNegativeCap is returned when an edge with negative capacity is added.
var ErrNegativeCap = errors.New("flow: negative capacity")

// Graph is a mutable flow network. The zero value is not ready for use;
// create one with New.
type Graph struct {
	edges map[string]Edge
	hist  []mutation
}

// mutation records one applied update so it can be undone.
type mutation struct {
	added bool // true: the update was an AddEdge
	edge  Edge
}

// New returns an empty graph.
func New() *Graph {
	return &Graph{edges: make(map[string]Edge)}
}

// AddEdge inserts an edge. The ID must be unique among current edges;
// parallel edges between the same endpoints need distinct IDs.
func (g *Graph) AddEdge(id string, from, to int, cap int64) error {
	if cap < 0 {
		return ErrNegativeCap
	}
	if _, ok := g.edges[id]; ok {
		return fmt.Errorf("flow: edge %q already exists", id)
	}
	e := Edge{ID: id, From: from, To: to, Cap: cap}
	g.edges[id] = e
	g.hist = append(g.hist, mutation{added: true, edge: e})
	return nil
}

// RemoveEdge deletes the edge with the given ID.
func (g *Graph) RemoveEdge(id string) error {
	e, ok := g.edges[id]
	if !ok {
		return fmt.Errorf("flow: edge %q not found", id)
	}
	delete(g.edges, id)
	g.hist = append(g.hist, mutation{added: false, edge: e})
	return nil
}

// Undo reverts the most recent AddEdge or RemoveEdge. It reports whether
// there was an update to undo.
func (g *Graph) Undo() bool {
	n := len(g.hist)
	if n == 0 {
		return false
	}
	m := g.hist[n-1]
	g.hist = g.hist[:n-1]
	if m.added {
		delete(g.edges, m.edge.ID)
	} else {
		g.edges[m.edge.ID] = m.edge
	}
	return true
}

// Edges returns the current edges sorted by ID.
func (g *Graph) Edges() []Edge {
	out := make([]Edge, 0, len(g.edges))
	for _, e := range g.edges {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Result is the outcome of a MaxFlow computation on one graph version.
type Result struct {
	// Value is the maximum flow value.
	Value int64
	// Cut is the source side of a minimum s-t cut: the vertices
	// reachable from s in the residual network. Its capacity equals
	// Value, certifying optimality.
	Cut []int
	// Flow maps each edge ID to the flow routed through it. It is a
	// feasible flow: 0 <= Flow[id] <= Cap and flow is conserved at
	// every vertex other than s and t.
	Flow map[string]int64
}

// arc is one residual-network arc.
type arc struct {
	to, rev int
	cap     int64
}

// MaxFlow computes the maximum flow from s to t on the current version
// using Dinic's algorithm, and returns the flow, its value, and a
// minimum-cut certificate. If s == t the zero Result is returned.
func (g *Graph) MaxFlow(s, t int) Result {
	res := Result{Flow: make(map[string]int64)}
	if s == t {
		return res
	}
	edges := g.Edges()

	// Assign dense indices to vertices, sorted for determinism.
	set := map[int]bool{s: true, t: true}
	for _, e := range edges {
		set[e.From] = true
		set[e.To] = true
	}
	verts := make([]int, 0, len(set))
	for v := range set {
		verts = append(verts, v)
	}
	sort.Ints(verts)
	idx := make(map[int]int, len(verts))
	for i, v := range verts {
		idx[v] = i
	}
	n := len(verts)
	si, ti := idx[s], idx[t]

	adj := make([][]arc, n)
	addArc := func(a, b int, c int64) {
		adj[a] = append(adj[a], arc{to: b, rev: len(adj[b]), cap: c})
		adj[b] = append(adj[b], arc{to: a, rev: len(adj[a]) - 1, cap: 0})
	}
	type loc struct{ node, pos int }
	fwd := make(map[string]loc, len(edges))
	for _, e := range edges {
		a, b := idx[e.From], idx[e.To]
		fwd[e.ID] = loc{a, len(adj[a])}
		addArc(a, b, e.Cap)
	}

	// Dinic's algorithm.
	level := make([]int, n)
	it := make([]int, n)
	bfs := func() bool {
		for i := range level {
			level[i] = -1
		}
		level[si] = 0
		q := []int{si}
		for len(q) > 0 {
			v := q[0]
			q = q[1:]
			for _, a := range adj[v] {
				if a.cap > 0 && level[a.to] < 0 {
					level[a.to] = level[v] + 1
					q = append(q, a.to)
				}
			}
		}
		return level[ti] >= 0
	}
	var dfs func(v int, f int64) int64
	dfs = func(v int, f int64) int64 {
		if v == ti {
			return f
		}
		for ; it[v] < len(adj[v]); it[v]++ {
			a := &adj[v][it[v]]
			if a.cap > 0 && level[a.to] == level[v]+1 {
				d := dfs(a.to, min64(f, a.cap))
				if d > 0 {
					a.cap -= d
					adj[a.to][a.rev].cap += d
					return d
				}
			}
		}
		return 0
	}
	const inf = int64(^uint64(0) >> 1)
	for bfs() {
		for i := range it {
			it[i] = 0
		}
		for {
			f := dfs(si, inf)
			if f == 0 {
				break
			}
			res.Value += f
		}
	}

	// Recover the per-edge flow from the residual capacities.
	for _, e := range edges {
		l := fwd[e.ID]
		res.Flow[e.ID] = e.Cap - adj[l.node][l.pos].cap
	}

	// Min-cut certificate: vertices reachable from s in the residual
	// network (one more BFS on the final residual graph).
	seen := make([]bool, n)
	seen[si] = true
	q := []int{si}
	for len(q) > 0 {
		v := q[0]
		q = q[1:]
		for _, a := range adj[v] {
			if a.cap > 0 && !seen[a.to] {
				seen[a.to] = true
				q = append(q, a.to)
			}
		}
	}
	for i, v := range verts {
		if seen[i] {
			res.Cut = append(res.Cut, v)
		}
	}
	return res
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
