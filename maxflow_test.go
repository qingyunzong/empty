package netflow

import (
	"math/rand"
	"testing"
)

// checkFeasible verifies capacity constraints and flow conservation.
func checkFeasible(t *testing.T, g *Graph, s, sink, value int, flow map[EdgeID]int) {
	t.Helper()
	balance := make([]int, g.NumVertices())
	for _, e := range g.Edges() {
		f, ok := flow[e.ID]
		if !ok {
			t.Fatalf("flow missing edge %d", e.ID)
		}
		if f < 0 || f > e.Cap {
			t.Fatalf("edge %d flow %d violates capacity %d", e.ID, f, e.Cap)
		}
		balance[e.From] -= f
		balance[e.To] += f
	}
	if len(flow) != g.NumEdges() {
		t.Fatalf("flow has %d entries, graph has %d edges", len(flow), g.NumEdges())
	}
	for v := 0; v < g.NumVertices(); v++ {
		switch v {
		case s:
			if balance[v] != -value {
				t.Fatalf("source balance %d, want %d", balance[v], -value)
			}
		case sink:
			if balance[v] != value {
				t.Fatalf("sink balance %d, want %d", balance[v], value)
			}
		default:
			if balance[v] != 0 {
				t.Fatalf("vertex %d violates conservation: balance %d", v, balance[v])
			}
		}
	}
}

// bruteForceMinCut enumerates all s-t cuts and returns the minimum
// cut capacity.
func bruteForceMinCut(g *Graph, s, sink int) int {
	n := g.NumVertices()
	// Vertices other than s and sink can be on either side.
	var free []int
	for v := 0; v < n; v++ {
		if v != s && v != sink {
			free = append(free, v)
		}
	}
	best := -1
	for mask := 0; mask < 1<<uint(len(free)); mask++ {
		side := make([]bool, n)
		side[s] = true
		for i, v := range free {
			side[v] = mask&(1<<uint(i)) != 0
		}
		cap := 0
		for _, e := range g.Edges() {
			if side[e.From] && !side[e.To] {
				cap += e.Cap
			}
		}
		if best < 0 || cap < best {
			best = cap
		}
	}
	return best
}

// checkVersion runs all invariants for the graph's current version.
func checkVersion(t *testing.T, g *Graph, s, sink int) {
	t.Helper()
	value, flow, cut := g.MaxFlow(s, sink)
	checkFeasible(t, g, s, sink, value, flow)
	if !cut.Side[s] || cut.Side[sink] {
		t.Fatalf("version %d: invalid cut sides", g.Version())
	}
	if got := cut.Capacity(g); got != value {
		t.Fatalf("version %d: cut capacity %d != flow value %d", g.Version(), got, value)
	}
	if want := bruteForceMinCut(g, s, sink); want != value {
		t.Fatalf("version %d: max flow %d != brute-force min cut %d", g.Version(), value, want)
	}
}

func TestKnownNetwork(t *testing.T) {
	// CLRS Fig. 26.1: max flow = 23.
	g := New(6)
	g.AddEdge(0, 1, 16)
	g.AddEdge(0, 2, 13)
	g.AddEdge(1, 2, 10)
	g.AddEdge(2, 1, 4)
	g.AddEdge(1, 3, 12)
	g.AddEdge(3, 2, 9)
	g.AddEdge(2, 4, 14)
	g.AddEdge(4, 3, 7)
	g.AddEdge(3, 5, 20)
	g.AddEdge(4, 5, 4)
	value, flow, cut := g.MaxFlow(0, 5)
	if value != 23 {
		t.Fatalf("max flow = %d, want 23", value)
	}
	checkFeasible(t, g, 0, 5, value, flow)
	if got := cut.Capacity(g); got != 23 {
		t.Fatalf("cut capacity = %d, want 23", got)
	}
}

func TestParallelEdges(t *testing.T) {
	g := New(2)
	a := g.AddEdge(0, 1, 3)
	b := g.AddEdge(0, 1, 5)
	c := g.AddEdge(0, 1, 2)
	if a == b || b == c || a == c {
		t.Fatal("parallel edges must get distinct IDs")
	}
	value, flow, cut := g.MaxFlow(0, 1)
	if value != 10 {
		t.Fatalf("max flow = %d, want 10", value)
	}
	if flow[a] != 3 || flow[b] != 5 || flow[c] != 2 {
		t.Fatalf("parallel edge flows = %d,%d,%d, want 3,5,2", flow[a], flow[b], flow[c])
	}
	if got := cut.Capacity(g); got != 10 {
		t.Fatalf("cut capacity = %d, want 10", got)
	}
	if len(cut.Crossing(g)) != 3 {
		t.Fatalf("cut crosses %d edges, want 3", len(cut.Crossing(g)))
	}
}

func TestUndoRestoresFlow(t *testing.T) {
	g := New(4)
	g.AddEdge(0, 1, 5)
	g.AddEdge(1, 3, 5)
	v1, _, _ := g.MaxFlow(0, 3)
	id := g.AddEdge(0, 2, 7)
	g.AddEdge(2, 3, 7)
	v2, _, _ := g.MaxFlow(0, 3)
	if v2 != v1+7 {
		t.Fatalf("after adds: flow %d, want %d", v2, v1+7)
	}
	g.Undo() // remove 2->3
	v3, _, _ := g.MaxFlow(0, 3)
	if v3 != v1 {
		t.Fatalf("after undo: flow %d, want %d", v3, v1)
	}
	g.Undo() // remove 0->2
	if g.NumEdges() != 2 {
		t.Fatalf("edges = %d, want 2", g.NumEdges())
	}
	if g.RemoveEdge(id) { // already gone via undo
		t.Fatalf("edge %d should not exist after undo", id)
	}
	// Undo of a remove re-inserts the edge.
	g.AddEdge(0, 3, 4)
	g.RemoveEdge(g.Edges()[0].ID)
	g.Undo()
	if g.NumEdges() != 3 {
		t.Fatalf("after undoing remove: edges = %d, want 3", g.NumEdges())
	}
	// Log holds [add(0,1), add(1,3), add(0,3)]: three undos drain it.
	for i := 0; i < 3; i++ {
		if !g.Undo() {
			t.Fatalf("undo %d should succeed", i)
		}
	}
	if g.Undo() {
		t.Fatal("undo on empty log should fail")
	}
	if g.NumEdges() != 0 {
		t.Fatalf("edges = %d, want 0", g.NumEdges())
	}
}

func TestRandomVersionsAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 60; trial++ {
		n := 2 + rng.Intn(5) // 2..6 vertices keeps enumeration cheap
		g := New(n)
		s, sink := 0, n-1
		var live []EdgeID
		ops := 1 + rng.Intn(12)
		for i := 0; i < ops; i++ {
			switch rng.Intn(3) {
			case 0: // add
				from, to := rng.Intn(n), rng.Intn(n)
				if from == to {
					continue
				}
				id := g.AddEdge(from, to, rng.Intn(10))
				live = append(live, id)
			case 1: // remove
				if len(live) == 0 {
					continue
				}
				k := rng.Intn(len(live))
				if g.RemoveEdge(live[k]) {
					live = append(live[:k], live[k+1:]...)
				}
			case 2: // undo
				if g.Undo() && len(live) > 0 {
					// Rebuild live set from scratch: simplest correct sync.
					live = live[:0]
					for _, e := range g.Edges() {
						live = append(live, e.ID)
					}
				}
			}
			checkVersion(t, g, s, sink)
		}
		// Undo everything, checking each version on the way down.
		for g.Undo() {
			checkVersion(t, g, s, sink)
		}
		checkVersion(t, g, s, sink)
	}
}

func TestDisconnectedAndZeroCapacity(t *testing.T) {
	g := New(3)
	g.AddEdge(0, 1, 0)
	g.AddEdge(1, 2, 5)
	value, flow, cut := g.MaxFlow(0, 2)
	if value != 0 {
		t.Fatalf("max flow = %d, want 0", value)
	}
	checkFeasible(t, g, 0, 2, value, flow)
	if got := cut.Capacity(g); got != 0 {
		t.Fatalf("cut capacity = %d, want 0", got)
	}
	if cut.Side[2] {
		t.Fatal("sink must be on the sink side")
	}
}
