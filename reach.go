// Package reach maintains the reachability relation of a directed graph
// under batches of edge insertions and deletions, and reports the net
// change of reachable pairs per committed batch.
//
// Correctness note on deletions: a common incremental approach keeps a
// "support count" per reachable pair and decrements it when an edge is
// removed. That approach is unsound in the presence of cycles: nodes on a
// cycle keep each other's support counts above zero through the very pairs
// that should disappear, so unreachable pairs are retained forever. This
// package therefore never reuses stale support information across a
// deletion. After each batch it recomputes the transitive closure from the
// current adjacency with an independent DFS per source, and derives the
// reported delta as the exact set difference against the previous
// committed closure.
package reach

import "sort"

// Edge is a directed edge from From to To.
type Edge struct {
	From, To int
}

// Pair is a reachable (Source, Target) pair. The closure is reflexive:
// every node reaches itself.
type Pair struct {
	Source, Target int
}

// Delta is the net change of the reachability relation caused by one
// committed batch. A pair appears in Added or Removed only if its
// reachability actually flipped; pairs inserted and removed within the
// same batch cancel out and appear in neither list. Both lists are sorted
// and deduplicated.
type Delta struct {
	Version uint64
	Added   []Pair
	Removed []Pair
}

// Graph is a mutable directed graph with versioned reachability snapshots.
type Graph struct {
	adj     map[int]map[int]struct{}
	reach   map[int]map[int]struct{}
	version uint64
	snaps   map[uint64]*Snapshot
}

// NewGraph returns an empty graph. Version 0 is the empty committed state.
func NewGraph() *Graph {
	g := &Graph{
		adj:   make(map[int]map[int]struct{}),
		reach: make(map[int]map[int]struct{}),
		snaps: make(map[uint64]*Snapshot),
	}
	g.snaps[0] = newSnapshot(0, g.reach)
	return g
}

// ApplyBatch applies deletes first, then inserts, commits the result as a
// new version, and returns the net reachability delta relative to the
// previously committed version. Edges or pairs listed multiple times are
// idempotent.
func (g *Graph) ApplyBatch(inserts, deletes []Edge) Delta {
	for _, e := range deletes {
		if outs, ok := g.adj[e.From]; ok {
			delete(outs, e.To)
			if len(outs) == 0 {
				delete(g.adj, e.From)
			}
		}
	}
	for _, e := range inserts {
		outs, ok := g.adj[e.From]
		if !ok {
			outs = make(map[int]struct{})
			g.adj[e.From] = outs
		}
		outs[e.To] = struct{}{}
	}

	next := closure(g.adj)
	delta := Delta{Version: g.version + 1}
	delta.Added = diffPairs(next, g.reach)
	delta.Removed = diffPairs(g.reach, next)

	g.reach = next
	g.version++
	g.snaps[g.version] = newSnapshot(g.version, g.reach)
	return delta
}

// Version returns the latest committed version.
func (g *Graph) Version() uint64 { return g.version }

// Reachable reports whether target is reachable from source in the latest
// committed version.
func (g *Graph) Reachable(source, target int) bool {
	_, ok := g.reach[source][target]
	return ok
}

// Snapshot returns an immutable view of the latest committed version.
func (g *Graph) Snapshot() *Snapshot { return g.snaps[g.version] }

// SnapshotAt returns the immutable view of a previously committed version.
// The second result is false if the version does not exist.
func (g *Graph) SnapshotAt(version uint64) (*Snapshot, bool) {
	s, ok := g.snaps[version]
	return s, ok
}

// Snapshot is an immutable, version-isolated view of the reachability
// relation. It is unaffected by later batches applied to the Graph.
type Snapshot struct {
	version uint64
	reach   map[int]map[int]struct{}
}

func newSnapshot(version uint64, reach map[int]map[int]struct{}) *Snapshot {
	cp := make(map[int]map[int]struct{}, len(reach))
	for src, set := range reach {
		inner := make(map[int]struct{}, len(set))
		for dst := range set {
			inner[dst] = struct{}{}
		}
		cp[src] = inner
	}
	return &Snapshot{version: version, reach: cp}
}

// Version returns the version this snapshot was taken at.
func (s *Snapshot) Version() uint64 { return s.version }

// Reachable reports whether target is reachable from source in this
// snapshot.
func (s *Snapshot) Reachable(source, target int) bool {
	_, ok := s.reach[source][target]
	return ok
}

// ReachableFrom returns the sorted set of nodes reachable from source.
func (s *Snapshot) ReachableFrom(source int) []int {
	set := s.reach[source]
	out := make([]int, 0, len(set))
	for dst := range set {
		out = append(out, dst)
	}
	sort.Ints(out)
	return out
}

// Pairs returns the full sorted reachability relation of this snapshot.
func (s *Snapshot) Pairs() []Pair { return pairsOf(s.reach) }

// closure computes the reflexive transitive closure of adj with an
// independent depth-first search per source. No state is shared between
// sources, and nothing is carried over from earlier versions, so deleted
// edges can never leave phantom reachable pairs behind.
func closure(adj map[int]map[int]struct{}) map[int]map[int]struct{} {
	nodes := make(map[int]struct{}, len(adj))
	for src, outs := range adj {
		nodes[src] = struct{}{}
		for dst := range outs {
			nodes[dst] = struct{}{}
		}
	}
	reach := make(map[int]map[int]struct{}, len(nodes))
	for src := range nodes {
		seen := make(map[int]struct{})
		stack := []int{src}
		for len(stack) > 0 {
			n := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if _, ok := seen[n]; ok {
				continue
			}
			seen[n] = struct{}{}
			for m := range adj[n] {
				stack = append(stack, m)
			}
		}
		reach[src] = seen
	}
	return reach
}

// diffPairs returns the sorted pairs present in a but absent from b.
func diffPairs(a, b map[int]map[int]struct{}) []Pair {
	var out []Pair
	for src, set := range a {
		for dst := range set {
			if _, ok := b[src][dst]; !ok {
				out = append(out, Pair{Source: src, Target: dst})
			}
		}
	}
	sortPairs(out)
	return out
}

func pairsOf(reach map[int]map[int]struct{}) []Pair {
	var out []Pair
	for src, set := range reach {
		for dst := range set {
			out = append(out, Pair{Source: src, Target: dst})
		}
	}
	sortPairs(out)
	return out
}

func sortPairs(pairs []Pair) {
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].Source != pairs[j].Source {
			return pairs[i].Source < pairs[j].Source
		}
		return pairs[i].Target < pairs[j].Target
	})
}
