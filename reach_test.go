package reach

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// oracleReach is the independent ground truth: a fresh per-source DFS over
// the given edge list, sharing no code or state with the library.
func oracleReach(edges []Edge) map[int]map[int]struct{} {
	adj := make(map[int][]int)
	nodes := make(map[int]struct{})
	for _, e := range edges {
		adj[e.From] = append(adj[e.From], e.To)
		nodes[e.From] = struct{}{}
		nodes[e.To] = struct{}{}
	}
	reach := make(map[int]map[int]struct{})
	for src := range nodes {
		seen := make(map[int]struct{})
		var visit func(n int)
		visit = func(n int) {
			if _, ok := seen[n]; ok {
				return
			}
			seen[n] = struct{}{}
			for _, m := range adj[n] {
				visit(m)
			}
		}
		visit(src)
		reach[src] = seen
	}
	return reach
}

func oraclePairs(edges []Edge) []Pair {
	return pairsOf(oracleReach(edges))
}

func pairSet(pairs []Pair) map[Pair]struct{} {
	set := make(map[Pair]struct{}, len(pairs))
	for _, p := range pairs {
		set[p] = struct{}{}
	}
	return set
}

func TestBridgeDeletion(t *testing.T) {
	g := NewGraph()
	chain := []Edge{{1, 2}, {2, 3}, {3, 4}}
	g.ApplyBatch(chain, nil)

	before := g.Snapshot()
	d := g.ApplyBatch(nil, []Edge{{2, 3}}) // cut the bridge

	wantRemoved := []Pair{{1, 3}, {1, 4}, {2, 3}, {2, 4}}
	if !reflect.DeepEqual(d.Removed, wantRemoved) {
		t.Fatalf("removed = %v, want %v", d.Removed, wantRemoved)
	}
	if len(d.Added) != 0 {
		t.Fatalf("added = %v, want none", d.Added)
	}
	for _, p := range wantRemoved {
		if g.Reachable(p.Source, p.Target) {
			t.Fatalf("pair %v still reachable after bridge cut", p)
		}
		if !before.Reachable(p.Source, p.Target) {
			t.Fatalf("pair %v missing from pre-cut snapshot", p)
		}
	}
	// Nodes upstream of the bridge keep their reachability.
	for _, p := range []Pair{{1, 1}, {1, 2}, {2, 2}, {3, 4}} {
		if !g.Reachable(p.Source, p.Target) {
			t.Fatalf("pair %v lost but should survive the bridge cut", p)
		}
	}
}

func TestCycleEdgeDeletionKeepsReachability(t *testing.T) {
	g := NewGraph()
	// Complete digraph on {1,2,3}: every ordered pair is an edge, so any
	// single edge is redundant.
	g.ApplyBatch([]Edge{{1, 2}, {2, 1}, {2, 3}, {3, 2}, {1, 3}, {3, 1}}, nil)

	// Removing one edge must not drop any reachable pair: every pair is
	// still supported by an alternate path through the third node.
	d := g.ApplyBatch(nil, []Edge{{3, 1}})
	if len(d.Removed) != 0 || len(d.Added) != 0 {
		t.Fatalf("delta = +%v -%v, want empty", d.Added, d.Removed)
	}
	for _, s := range []int{1, 2, 3} {
		for _, t2 := range []int{1, 2, 3} {
			if !g.Reachable(s, t2) {
				t.Fatalf("pair (%d,%d) lost after intra-cycle edge deletion", s, t2)
			}
		}
	}
}

func TestDirectedCycleBreakRemovesPairs(t *testing.T) {
	g := NewGraph()
	g.ApplyBatch([]Edge{{1, 2}, {2, 3}, {3, 1}}, nil)

	// A directed cycle has no redundant edge: cutting 3->1 strands every
	// pair that needed it. A support-counting implementation never sees
	// these counts reach zero, because 1, 2 and 3 keep each other's
	// counts alive through the very pairs that should disappear.
	d := g.ApplyBatch(nil, []Edge{{3, 1}})
	wantRemoved := []Pair{{2, 1}, {3, 1}, {3, 2}}
	if !reflect.DeepEqual(d.Removed, wantRemoved) {
		t.Fatalf("removed = %v, want %v", d.Removed, wantRemoved)
	}
	if len(d.Added) != 0 {
		t.Fatalf("added = %v, want none", d.Added)
	}
}

func TestCycleBreakDropsDownstreamPairs(t *testing.T) {
	g := NewGraph()
	// Cycle 1->2->3->1 with a tail 3->4.
	g.ApplyBatch([]Edge{{1, 2}, {2, 3}, {3, 1}, {3, 4}}, nil)
	d := g.ApplyBatch(nil, []Edge{{2, 3}}) // break the cycle

	// 3 still reaches everything via 3->1->2; 1 and 2 lose the cycle.
	wantRemoved := []Pair{{1, 3}, {1, 4}, {2, 1}, {2, 3}, {2, 4}}
	if !reflect.DeepEqual(d.Removed, wantRemoved) {
		t.Fatalf("removed = %v, want %v", d.Removed, wantRemoved)
	}
	if g.Reachable(1, 4) {
		t.Fatal("1 must no longer reach the tail 4")
	}
	if !g.Reachable(3, 4) || !g.Reachable(3, 2) {
		t.Fatal("3 must keep reaching 4 and 2 via 3->1->2")
	}
}

func TestBatchNetDeltaCancelsChurn(t *testing.T) {
	g := NewGraph()
	g.ApplyBatch([]Edge{{1, 2}, {2, 3}}, nil)

	// Delete and re-insert the same edge in one batch: net effect zero.
	d := g.ApplyBatch([]Edge{{1, 2}}, []Edge{{1, 2}})
	if len(d.Added) != 0 || len(d.Removed) != 0 {
		t.Fatalf("delta = +%v -%v, want empty for canceling churn", d.Added, d.Removed)
	}

	// Rewire in one batch: only net pair flips are reported. Pairs that
	// stay reachable through a different path appear in neither list.
	d = g.ApplyBatch([]Edge{{3, 4}, {4, 5}}, []Edge{{2, 3}})
	wantAdded := []Pair{{3, 4}, {3, 5}, {4, 4}, {4, 5}, {5, 5}}
	wantRemoved := []Pair{{1, 3}, {2, 3}}
	if !reflect.DeepEqual(d.Added, wantAdded) {
		t.Fatalf("added = %v, want %v", d.Added, wantAdded)
	}
	if !reflect.DeepEqual(d.Removed, wantRemoved) {
		t.Fatalf("removed = %v, want %v", d.Removed, wantRemoved)
	}
}

func TestSnapshotVersionIsolation(t *testing.T) {
	g := NewGraph()
	v0 := g.Snapshot()
	g.ApplyBatch([]Edge{{1, 2}, {2, 3}}, nil)
	v1 := g.Snapshot()
	g.ApplyBatch(nil, []Edge{{1, 2}})
	v2 := g.Snapshot()

	if v0.Version() != 0 || v1.Version() != 1 || v2.Version() != 2 {
		t.Fatalf("versions = %d,%d,%d, want 0,1,2", v0.Version(), v1.Version(), v2.Version())
	}
	if !v1.Reachable(1, 3) {
		t.Fatal("v1 snapshot mutated by a later batch")
	}
	if v2.Reachable(1, 3) || !v2.Reachable(2, 3) {
		t.Fatal("v2 snapshot does not reflect the deletion")
	}
	got, ok := g.SnapshotAt(1)
	if !ok || got != v1 {
		t.Fatal("SnapshotAt(1) did not return the committed v1 snapshot")
	}
	if _, ok := g.SnapshotAt(99); ok {
		t.Fatal("SnapshotAt(99) should report a missing version")
	}
	if want := []int{1, 2, 3}; !reflect.DeepEqual(v1.ReachableFrom(1), want) {
		t.Fatalf("v1.ReachableFrom(1) = %v, want %v", v1.ReachableFrom(1), want)
	}
}

func TestRandomizedAgainstOracle(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	g := NewGraph()
	var edges []Edge
	edgeSet := make(map[Edge]struct{})
	prev := oraclePairs(edges)

	for batch := 0; batch < 200; batch++ {
		var ins, del []Edge
		// Model the library's batch semantics: deletes first, then inserts.
		for i := 0; i < 1+rng.Intn(4); i++ {
			if len(edges) == 0 {
				break
			}
			idx := rng.Intn(len(edges))
			e := edges[idx]
			edges = append(edges[:idx], edges[idx+1:]...)
			delete(edgeSet, e)
			del = append(del, e)
		}
		for i := 0; i < 1+rng.Intn(6); i++ {
			e := Edge{rng.Intn(12), rng.Intn(12)}
			if _, ok := edgeSet[e]; !ok {
				edgeSet[e] = struct{}{}
				edges = append(edges, e)
				ins = append(ins, e)
			}
		}

		d := g.ApplyBatch(ins, del)
		now := oraclePairs(edges)

		if got := g.Snapshot().Pairs(); !reflect.DeepEqual(got, now) {
			t.Fatalf("batch %d: closure mismatch vs per-source DFS oracle\ngot  %v\nwant %v", batch, got, now)
		}

		prevSet, nowSet := pairSet(prev), pairSet(now)
		var wantAdded, wantRemoved []Pair
		for p := range nowSet {
			if _, ok := prevSet[p]; !ok {
				wantAdded = append(wantAdded, p)
			}
		}
		for p := range prevSet {
			if _, ok := nowSet[p]; !ok {
				wantRemoved = append(wantRemoved, p)
			}
		}
		sortPairs(wantAdded)
		sortPairs(wantRemoved)
		if !reflect.DeepEqual(d.Added, wantAdded) || !reflect.DeepEqual(d.Removed, wantRemoved) {
			t.Fatalf("batch %d: delta = +%v -%v, want +%v -%v", batch, d.Added, d.Removed, wantAdded, wantRemoved)
		}
		if d.Version != uint64(batch+1) {
			t.Fatalf("batch %d: delta version = %d", batch, d.Version)
		}
		prev = now
	}
}

func TestPairsSortedAndDeduped(t *testing.T) {
	g := NewGraph()
	g.ApplyBatch([]Edge{{3, 1}, {1, 2}, {1, 2}, {2, 3}}, nil)
	pairs := g.Snapshot().Pairs()
	if !sort.SliceIsSorted(pairs, func(i, j int) bool {
		if pairs[i].Source != pairs[j].Source {
			return pairs[i].Source < pairs[j].Source
		}
		return pairs[i].Target < pairs[j].Target
	}) {
		t.Fatalf("pairs not sorted: %v", pairs)
	}
	if got := len(pairSet(pairs)); got != len(pairs) {
		t.Fatalf("duplicate pairs in %v", pairs)
	}
}
