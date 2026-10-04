package reach

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// independentReach recomputes the reachable set of src with its own DFS
// over the raw edge list, fully independent of the library's internals.
func independentReach(edges []Edge, src string) map[string]bool {
	adj := make(map[string][]string)
	for _, e := range edges {
		adj[e.From] = append(adj[e.From], e.To)
	}
	seen := map[string]bool{}
	stack := append([]string(nil), adj[src]...)
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[n] {
			continue
		}
		seen[n] = true
		stack = append(stack, adj[n]...)
	}
	return seen
}

// independentClosure runs one DFS per source node and returns all pairs.
func independentClosure(edges []Edge) []Pair {
	nodes := map[string]bool{}
	for _, e := range edges {
		nodes[e.From] = true
		nodes[e.To] = true
	}
	var out []Pair
	for src := range nodes {
		for dst := range independentReach(edges, src) {
			out = append(out, Pair{src, dst})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].From != out[j].From {
			return out[i].From < out[j].From
		}
		return out[i].To < out[j].To
	})
	return out
}

// verifyAgainstDFS cross-checks the snapshot's maintained relation against
// an independent per-source DFS over the given live edges.
func verifyAgainstDFS(t *testing.T, s *Snapshot, edges []Edge) {
	t.Helper()
	want := independentClosure(edges)
	got := s.Pairs()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("version %d: maintained pairs diverge from independent DFS\ngot:  %v\nwant: %v", s.Version(), got, want)
	}
}

func pairsEqual(got, want []Pair) bool {
	sort.Slice(got, func(i, j int) bool {
		if got[i].From != got[j].From {
			return got[i].From < got[j].From
		}
		return got[i].To < got[j].To
	})
	return reflect.DeepEqual(got, want)
}

func TestBridgeDeletion(t *testing.T) {
	g := New()
	edges := []Edge{{"a", "b"}, {"b", "c"}, {"c", "d"}}
	g.ApplyBatch(edges, nil)
	verifyAgainstDFS(t, g.Snapshot(), edges)

	// b->c is the only bridge between {a,b} and {c,d}.
	d := g.RemoveEdge("b", "c")
	live := []Edge{{"a", "b"}, {"c", "d"}}
	verifyAgainstDFS(t, g.Snapshot(), live)

	wantRemoved := []Pair{{"a", "c"}, {"a", "d"}, {"b", "c"}, {"b", "d"}}
	if !pairsEqual(d.Removed, wantRemoved) {
		t.Fatalf("removed = %v, want %v", d.Removed, wantRemoved)
	}
	if len(d.Added) != 0 {
		t.Fatalf("added = %v, want none", d.Added)
	}
	if g.Reachable("a", "d") || g.Reachable("b", "c") {
		t.Fatal("unreachable pairs survived bridge deletion")
	}
}

func TestCycleEdgeDeletion(t *testing.T) {
	g := New()
	edges := []Edge{{"a", "b"}, {"b", "c"}, {"c", "a"}, {"c", "d"}}
	g.ApplyBatch(edges, nil)
	if !g.Reachable("a", "a") {
		t.Fatal("node in cycle must reach itself")
	}

	// Delete an edge inside the cycle: the cycle breaks into a chain.
	d := g.RemoveEdge("c", "a")
	live := []Edge{{"a", "b"}, {"b", "c"}, {"c", "d"}}
	verifyAgainstDFS(t, g.Snapshot(), live)

	wantRemoved := []Pair{{"a", "a"}, {"b", "a"}, {"b", "b"}, {"c", "a"}, {"c", "b"}, {"c", "c"}}
	if !pairsEqual(d.Removed, wantRemoved) {
		t.Fatalf("removed = %v, want %v", d.Removed, wantRemoved)
	}
	if g.Reachable("c", "a") || g.Reachable("b", "b") {
		t.Fatal("cycle-only pairs survived in-cycle edge deletion")
	}
	if !g.Reachable("a", "d") {
		t.Fatal("chain reachability lost after in-cycle deletion")
	}
}

// TestStaleSupportTrap is the regression test for cycling old support:
// in a 2-cycle every pair is supported by the other, so a deletion
// algorithm that revalidates against previously derived pairs would keep
// pairs that no longer have any real path.
func TestStaleSupportTrap(t *testing.T) {
	g := New()
	g.ApplyBatch([]Edge{{"a", "b"}, {"b", "a"}}, nil)
	for _, p := range []Pair{{"a", "a"}, {"a", "b"}, {"b", "a"}, {"b", "b"}} {
		if !g.Reachable(p.From, p.To) {
			t.Fatalf("pair %v missing before deletion", p)
		}
	}

	d := g.RemoveEdge("a", "b")
	verifyAgainstDFS(t, g.Snapshot(), []Edge{{"b", "a"}})

	wantRemoved := []Pair{{"a", "a"}, {"a", "b"}, {"b", "b"}}
	if !pairsEqual(d.Removed, wantRemoved) {
		t.Fatalf("removed = %v, want %v", d.Removed, wantRemoved)
	}
	if g.Reachable("a", "a") || g.Reachable("a", "b") || g.Reachable("b", "b") {
		t.Fatal("stale support kept unreachable pairs alive")
	}
	if !g.Reachable("b", "a") {
		t.Fatal("live pair b->a wrongly removed")
	}
}

func TestBatchNetDelta(t *testing.T) {
	g := New()
	g.ApplyBatch([]Edge{{"a", "b"}, {"b", "c"}}, nil)

	// Reroute a->b to a->c inside one batch: (a,c) survives on both sides
	// of the commit and must not appear in the net delta.
	d := g.ApplyBatch([]Edge{{"a", "c"}}, []Edge{{"a", "b"}})
	verifyAgainstDFS(t, g.Snapshot(), []Edge{{"a", "c"}, {"b", "c"}})
	if !pairsEqual(d.Removed, []Pair{{"a", "b"}}) || len(d.Added) != 0 {
		t.Fatalf("delta = +%v -%v, want +[] -[(a,b)]", d.Added, d.Removed)
	}

	// Add and remove the same edge in one batch: zero net change.
	d = g.ApplyBatch([]Edge{{"x", "y"}}, []Edge{{"x", "y"}})
	if len(d.Added) != 0 || len(d.Removed) != 0 {
		t.Fatalf("cancelled edge leaked into delta: +%v -%v", d.Added, d.Removed)
	}
}

func TestSnapshotIsolation(t *testing.T) {
	g := New()
	g.ApplyBatch([]Edge{{"a", "b"}, {"b", "c"}}, nil)
	v1 := g.Snapshot()

	g.RemoveEdge("b", "c")
	v2 := g.Snapshot()

	if v1.Version() == v2.Version() {
		t.Fatal("versions must differ across commits")
	}
	if !v1.Reachable("a", "c") {
		t.Fatal("old snapshot polluted by later deletion")
	}
	if v2.Reachable("a", "c") {
		t.Fatal("new snapshot missing deletion")
	}
	if got := g.SnapshotAt(v1.Version()); got != v1 {
		t.Fatal("SnapshotAt did not return the sealed version")
	}
	if g.SnapshotAt(999) != nil {
		t.Fatal("unknown version must return nil")
	}
}

// TestRandomizedCrossCheck applies random batches and, after every commit,
// cross-checks the maintained relation against independent per-source DFS.
func TestRandomizedCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	g := New()
	names := []string{"a", "b", "c", "d", "e", "f"}
	live := map[Edge]bool{}

	for round := 0; round < 200; round++ {
		var adds, removes []Edge
		inBatch := map[Edge]bool{}
		for i := 0; i < 1+rng.Intn(4); i++ {
			e := Edge{names[rng.Intn(len(names))], names[rng.Intn(len(names))]}
			if inBatch[e] {
				continue
			}
			inBatch[e] = true
			if live[e] || rng.Intn(2) == 0 {
				removes = append(removes, e)
				delete(live, e)
			} else {
				adds = append(adds, e)
				live[e] = true
			}
		}
		g.ApplyBatch(adds, removes)

		var edges []Edge
		for e := range live {
			edges = append(edges, e)
		}
		snap := g.Snapshot()
		t.Run(fmt.Sprintf("round_%d", round), func(t *testing.T) {
			verifyAgainstDFS(t, snap, edges)
		})
	}
}
