// Package cfglib provides a versioned control-flow graph whose entry
// dominator tree is maintained across edge insertions and deletions.
// Unreachable nodes are tracked separately, nearest common dominator and
// dominance frontier queries are supported, and every mutation produces a
// new immutable version so older versions remain readable.
package cfglib

import "sort"

// Graph is an immutable, versioned control-flow graph. Every mutation
// returns a new *Graph with a bumped version; previously returned versions
// stay readable and unchanged.
type Graph struct {
	version int
	entry   string
	nodes   map[string]struct{}
	succ    map[string]map[string]struct{}
	pred    map[string]map[string]struct{}
}

// New returns a version-0 graph containing only the entry node.
func New(entry string) *Graph {
	return &Graph{
		entry: entry,
		nodes: map[string]struct{}{entry: {}},
		succ:  make(map[string]map[string]struct{}),
		pred:  make(map[string]map[string]struct{}),
	}
}

// Version returns the graph version, incremented by every effective mutation.
func (g *Graph) Version() int { return g.version }

// Entry returns the entry node.
func (g *Graph) Entry() string { return g.entry }

func (g *Graph) clone() *Graph {
	ng := &Graph{
		version: g.version + 1,
		entry:   g.entry,
		nodes:   make(map[string]struct{}, len(g.nodes)),
		succ:    make(map[string]map[string]struct{}, len(g.succ)),
		pred:    make(map[string]map[string]struct{}, len(g.pred)),
	}
	for n := range g.nodes {
		ng.nodes[n] = struct{}{}
	}
	for n, set := range g.succ {
		ns := make(map[string]struct{}, len(set))
		for s := range set {
			ns[s] = struct{}{}
		}
		ng.succ[n] = ns
	}
	for n, set := range g.pred {
		ns := make(map[string]struct{}, len(set))
		for p := range set {
			ns[p] = struct{}{}
		}
		ng.pred[n] = ns
	}
	return ng
}

// HasNode reports whether n exists in the graph.
func (g *Graph) HasNode(n string) bool {
	_, ok := g.nodes[n]
	return ok
}

// HasEdge reports whether the edge from->to exists.
func (g *Graph) HasEdge(from, to string) bool {
	_, ok := g.succ[from][to]
	return ok
}

// AddNode returns a new version with node n added. Adding an existing node
// is a no-op that returns the same graph.
func (g *Graph) AddNode(n string) *Graph {
	if g.HasNode(n) {
		return g
	}
	ng := g.clone()
	ng.nodes[n] = struct{}{}
	return ng
}

// AddEdge returns a new version with the edge from->to added. Missing
// endpoints are added implicitly. Adding an existing edge is a no-op that
// returns the same graph.
func (g *Graph) AddEdge(from, to string) *Graph {
	if g.HasEdge(from, to) {
		return g
	}
	ng := g.clone()
	ng.nodes[from] = struct{}{}
	ng.nodes[to] = struct{}{}
	if ng.succ[from] == nil {
		ng.succ[from] = make(map[string]struct{})
	}
	ng.succ[from][to] = struct{}{}
	if ng.pred[to] == nil {
		ng.pred[to] = make(map[string]struct{})
	}
	ng.pred[to][from] = struct{}{}
	return ng
}

// RemoveEdge returns a new version with the edge from->to removed. Removing
// a non-existent edge is a no-op that returns the same graph.
func (g *Graph) RemoveEdge(from, to string) *Graph {
	if !g.HasEdge(from, to) {
		return g
	}
	ng := g.clone()
	delete(ng.succ[from], to)
	delete(ng.pred[to], from)
	return ng
}

// Nodes returns all node names in sorted order.
func (g *Graph) Nodes() []string {
	out := make([]string, 0, len(g.nodes))
	for n := range g.nodes {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// Successors returns the sorted successors of n.
func (g *Graph) Successors(n string) []string {
	return sortedKeys(g.succ[n])
}

// Predecessors returns the sorted predecessors of n.
func (g *Graph) Predecessors(n string) []string {
	return sortedKeys(g.pred[n])
}

func sortedKeys(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
