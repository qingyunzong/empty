package flow

import (
	"fmt"
	"math/rand"
	"sort"
	"testing"
)

// checkFeasible verifies that res.Flow is a feasible s-t flow on g and
// that res.Value equals the net flow out of s.
func checkFeasible(t *testing.T, g *Graph, res Result, s, sink int) {
	t.Helper()
	balance := map[int]int64{}
	for _, e := range g.Edges() {
		f, ok := res.Flow[e.ID]
		if !ok {
			t.Fatalf("missing flow for edge %q", e.ID)
		}
		if f < 0 || f > e.Cap {
			t.Fatalf("capacity violated on edge %q: flow %d, cap %d", e.ID, f, e.Cap)
		}
		balance[e.From] -= f
		balance[e.To] += f
	}
	for v, b := range balance {
		if v != s && v != sink && b != 0 {
			t.Fatalf("flow not conserved at vertex %d: balance %d", v, b)
		}
	}
	if -balance[s] != res.Value {
		t.Fatalf("value %d != net outflow of s %d", res.Value, -balance[s])
	}
	if balance[sink] != res.Value {
		t.Fatalf("value %d != net inflow of t %d", res.Value, balance[sink])
	}
}

// checkCertificate verifies the min-cut certificate: the cut must
// separate s from t and its capacity must equal the flow value.
func checkCertificate(t *testing.T, g *Graph, res Result, s, sink int) {
	t.Helper()
	inCut := map[int]bool{}
	for _, v := range res.Cut {
		inCut[v] = true
	}
	if !inCut[s] {
		t.Fatalf("cut %v does not contain source %d", res.Cut, s)
	}
	if inCut[sink] {
		t.Fatalf("cut %v contains sink %d", res.Cut, sink)
	}
	var cap int64
	for _, e := range g.Edges() {
		if inCut[e.From] && !inCut[e.To] {
			cap += e.Cap
		}
	}
	if cap != res.Value {
		t.Fatalf("cut capacity %d != flow value %d", cap, res.Value)
	}
}

// bruteForceMinCut enumerates all s-t cuts and returns the minimum cut
// capacity. Only suitable for small graphs.
func bruteForceMinCut(g *Graph, s, sink int) int64 {
	set := map[int]bool{s: true, sink: true}
	for _, e := range g.Edges() {
		set[e.From] = true
		set[e.To] = true
	}
	var mid []int
	for v := range set {
		if v != s && v != sink {
			mid = append(mid, v)
		}
	}
	sort.Ints(mid)
	best := int64(-1)
	for mask := 0; mask < 1<<uint(len(mid)); mask++ {
		inCut := map[int]bool{s: true}
		for i, v := range mid {
			if mask&(1<<uint(i)) != 0 {
				inCut[v] = true
			}
		}
		var cap int64
		for _, e := range g.Edges() {
			if inCut[e.From] && !inCut[e.To] {
				cap += e.Cap
			}
		}
		if best < 0 || cap < best {
			best = cap
		}
	}
	return best
}

// checkVersion runs all verifications for the current graph version.
func checkVersion(t *testing.T, g *Graph, s, sink int) Result {
	t.Helper()
	res := g.MaxFlow(s, sink)
	checkFeasible(t, g, res, s, sink)
	checkCertificate(t, g, res, s, sink)
	if want := bruteForceMinCut(g, s, sink); res.Value != want {
		t.Fatalf("max flow %d != brute-force min cut %d", res.Value, want)
	}
	return res
}

// TestClassic uses the CLRS flow network (Fig. 26.x); max flow is 23.
func TestClassic(t *testing.T) {
	g := New()
	// 0=s, 5=t
	edges := []Edge{
		{"a", 0, 1, 16}, {"b", 0, 2, 13}, {"c", 1, 3, 12},
		{"d", 2, 1, 4}, {"e", 2, 4, 14}, {"f", 3, 2, 9},
		{"g", 3, 5, 20}, {"h", 4, 3, 7}, {"i", 4, 5, 4},
	}
	for _, e := range edges {
		if err := g.AddEdge(e.ID, e.From, e.To, e.Cap); err != nil {
			t.Fatal(err)
		}
	}
	res := checkVersion(t, g, 0, 5)
	if res.Value != 23 {
		t.Fatalf("max flow = %d, want 23", res.Value)
	}
}

// TestParallelEdges ensures parallel edges are distinguished by ID.
func TestParallelEdges(t *testing.T) {
	g := New()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(g.AddEdge("p1", 0, 1, 5))
	must(g.AddEdge("p2", 0, 1, 7))
	if err := g.AddEdge("p1", 0, 1, 1); err == nil {
		t.Fatal("duplicate ID accepted")
	}
	if got := checkVersion(t, g, 0, 1).Value; got != 12 {
		t.Fatalf("max flow = %d, want 12", got)
	}
	must(g.RemoveEdge("p1"))
	if got := checkVersion(t, g, 0, 1).Value; got != 7 {
		t.Fatalf("max flow = %d, want 7", got)
	}
	if err := g.RemoveEdge("p1"); err == nil {
		t.Fatal("removing unknown edge succeeded")
	}
	if err := g.AddEdge("neg", 0, 1, -1); err != ErrNegativeCap {
		t.Fatalf("negative capacity: got %v", err)
	}
}

// TestUndo checks that undo restores earlier versions exactly.
func TestUndo(t *testing.T) {
	g := New()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	s, sink := 0, 3
	var values []int64
	record := func() { values = append(values, checkVersion(t, g, s, sink).Value) }

	record()
	must(g.AddEdge("e1", 0, 1, 3))
	record()
	must(g.AddEdge("e2", 1, 3, 2))
	record()
	must(g.AddEdge("e3", 0, 2, 4))
	record()
	must(g.AddEdge("e4", 2, 3, 5))
	record()
	must(g.RemoveEdge("e1"))
	record()
	must(g.AddEdge("e5", 1, 2, 1))
	record()

	for g.Undo() {
		record()
	}
	if len(values) != 13 {
		t.Fatalf("recorded %d versions, want 13", len(values))
	}
	for i := 0; i < 6; i++ {
		if values[i] != values[12-i] {
			t.Fatalf("version %d value %d != mirrored value %d", i, values[i], values[12-i])
		}
	}
	if len(g.Edges()) != 0 {
		t.Fatalf("graph not empty after undoing everything: %v", g.Edges())
	}
	if g.Undo() {
		t.Fatal("Undo on empty history returned true")
	}
}

// TestRandomized applies random add/remove/undo operations on small
// graphs and verifies every version against cut enumeration.
func TestRandomized(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 200; trial++ {
		g := New()
		n := 2 + rng.Intn(6) // 2..7 vertices
		s, sink := 0, n-1
		var ids []string
		nextID := 0
		for step := 0; step < 40; step++ {
			switch r := rng.Intn(10); {
			case r < 5 || len(ids) == 0: // add
				id := fmt.Sprintf("e%d", nextID)
				nextID++
				from, to := rng.Intn(n), rng.Intn(n)
				cap := int64(rng.Intn(10)) // 0..9, includes zero-cap edges
				if err := g.AddEdge(id, from, to, cap); err != nil {
					t.Fatal(err)
				}
				ids = append(ids, id)
			case r < 8: // remove
				i := rng.Intn(len(ids))
				if err := g.RemoveEdge(ids[i]); err != nil {
					t.Fatal(err)
				}
				ids = append(ids[:i], ids[i+1:]...)
			default: // undo
				if g.Undo() {
					// Rebuild the ID list from scratch; cheap for small graphs.
					ids = ids[:0]
					for _, e := range g.Edges() {
						ids = append(ids, e.ID)
					}
				}
			}
			checkVersion(t, g, s, sink)
		}
	}
}

// TestDisconnected covers graphs where t is unreachable from s.
func TestDisconnected(t *testing.T) {
	g := New()
	if err := g.AddEdge("x", 0, 1, 5); err != nil {
		t.Fatal(err)
	}
	res := checkVersion(t, g, 0, 2)
	if res.Value != 0 {
		t.Fatalf("max flow = %d, want 0", res.Value)
	}
	if len(res.Cut) == 0 {
		t.Fatal("cut certificate is empty")
	}
}
