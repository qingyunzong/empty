// Package reach maintains the reachability relation (transitive closure)
// of a directed graph under edge insertions and deletions.
//
// Correctness policy for deletions: the closure is always recomputed from
// the live edge set, never patched by cycling through previously derived
// support pairs. A pair therefore survives an edge deletion only if a path
// still exists in the current graph.
//
// Each batch of corrections is committed atomically: it produces the net
// added/removed reachability pairs and seals a new immutable snapshot
// version, isolated from all later mutations.
package reach

import "sort"

// Edge is a directed edge From -> To.
type Edge struct {
	From, To string
}

// Pair is a reachability fact: To is reachable from From via one or more
// edges. A node reaches itself only through a cycle.
type Pair struct {
	From, To string
}

// Delta is the net change of the reachability relation caused by one
// committed batch. Pairs cancelled out inside the batch never appear.
type Delta struct {
	Added   []Pair
	Removed []Pair
}

// Snapshot is an immutable, version-isolated view of the reachability
// relation. It is unaffected by any later mutation of the Graph.
type Snapshot struct {
	version uint64
	closure map[string]map[string]struct{}
}

// Version returns the committed version this snapshot reflects.
func (s *Snapshot) Version() uint64 { return s.version }

// Reachable reports whether to is reachable from from in this version.
func (s *Snapshot) Reachable(from, to string) bool {
	_, ok := s.closure[from][to]
	return ok
}

// Pairs returns the full reachability relation of this version, sorted.
func (s *Snapshot) Pairs() []Pair { return sortedPairs(s.closure) }

// Graph is a mutable directed graph with versioned reachability snapshots.
type Graph struct {
	edges   map[string]map[string]struct{}
	nodes   map[string]struct{}
	version uint64
	snaps   map[uint64]*Snapshot
}

// New returns an empty graph at version 0.
func New() *Graph {
	g := &Graph{
		edges: make(map[string]map[string]struct{}),
		nodes: make(map[string]struct{}),
		snaps: make(map[uint64]*Snapshot),
	}
	g.commit()
	return g
}

// Version returns the latest committed version.
func (g *Graph) Version() uint64 { return g.version }

// AddEdge commits a single edge insertion.
func (g *Graph) AddEdge(from, to string) Delta {
	return g.ApplyBatch([]Edge{{from, to}}, nil)
}

// RemoveEdge commits a single edge deletion.
func (g *Graph) RemoveEdge(from, to string) Delta {
	return g.ApplyBatch(nil, []Edge{{from, to}})
}

// ApplyBatch atomically applies a batch of edge corrections, recomputes
// the reachability relation from the surviving edge set, and returns the
// net added/removed pairs relative to the previous committed version.
func (g *Graph) ApplyBatch(adds, removes []Edge) Delta {
	for _, e := range adds {
		g.nodes[e.From] = struct{}{}
		g.nodes[e.To] = struct{}{}
		if g.edges[e.From] == nil {
			g.edges[e.From] = make(map[string]struct{})
		}
		g.edges[e.From][e.To] = struct{}{}
	}
	for _, e := range removes {
		delete(g.edges[e.From], e.To)
	}
	return g.commit()
}

// Reachable reports whether to is reachable from from in the latest version.
func (g *Graph) Reachable(from, to string) bool {
	return g.snaps[g.version].Reachable(from, to)
}

// Snapshot returns the immutable view of the latest committed version.
func (g *Graph) Snapshot() *Snapshot { return g.snaps[g.version] }

// SnapshotAt returns the immutable view of an earlier committed version,
// or nil if that version does not exist.
func (g *Graph) SnapshotAt(version uint64) *Snapshot { return g.snaps[version] }

// commit recomputes the closure from scratch and seals a new version.
func (g *Graph) commit() Delta {
	next := make(map[string]map[string]struct{}, len(g.nodes))
	for src := range g.nodes {
		next[src] = g.reachableFrom(src)
	}
	prev := g.snaps[g.version]
	var d Delta
	if prev != nil {
		d.Removed = diffPairs(prev.closure, next)
	}
	d.Added = diffPairs(next, snapshotClosure(prev))
	g.version++
	g.snaps[g.version] = &Snapshot{version: g.version, closure: next}
	return d
}

func snapshotClosure(s *Snapshot) map[string]map[string]struct{} {
	if s == nil {
		return nil
	}
	return s.closure
}

// reachableFrom returns every node reachable from src via one or more
// edges, using an iterative DFS over the live edge set only.
func (g *Graph) reachableFrom(src string) map[string]struct{} {
	seen := make(map[string]struct{})
	stack := make([]string, 0, len(g.edges[src]))
	for dst := range g.edges[src] {
		stack = append(stack, dst)
	}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if _, ok := seen[n]; ok {
			continue
		}
		seen[n] = struct{}{}
		for dst := range g.edges[n] {
			if _, ok := seen[dst]; !ok {
				stack = append(stack, dst)
			}
		}
	}
	return seen
}

// diffPairs returns the sorted pairs present in a but absent from b.
func diffPairs(a, b map[string]map[string]struct{}) []Pair {
	var out []Pair
	for from, tos := range a {
		for to := range tos {
			if _, ok := b[from][to]; !ok {
				out = append(out, Pair{from, to})
			}
		}
	}
	sortPairs(out)
	return out
}

func sortedPairs(closure map[string]map[string]struct{}) []Pair {
	var out []Pair
	for from, tos := range closure {
		for to := range tos {
			out = append(out, Pair{from, to})
		}
	}
	sortPairs(out)
	return out
}

func sortPairs(pairs []Pair) {
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].From != pairs[j].From {
			return pairs[i].From < pairs[j].From
		}
		return pairs[i].To < pairs[j].To
	})
}
