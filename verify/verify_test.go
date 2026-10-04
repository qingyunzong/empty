package verify_test

import (
	"testing"

	"graphlib/graph"
	"graphlib/verify"
)

func TestCheckMatching(t *testing.T) {
	edges := []verify.Edge{{L: "a", R: "x"}, {L: "b", R: "y"}}
	if err := verify.CheckMatching(edges, edges); err != nil {
		t.Fatalf("valid matching rejected: %v", err)
	}
	if err := verify.CheckMatching(edges, []verify.Edge{{L: "a", R: "y"}}); err == nil {
		t.Fatal("matching with nonexistent edge accepted")
	}
	if err := verify.CheckMatching(edges, []verify.Edge{{L: "a", R: "x"}, {L: "a", R: "y"}}); err == nil {
		t.Fatal("matching reusing a vertex accepted")
	}
}

func TestCheckCover(t *testing.T) {
	edges := []verify.Edge{{L: "a", R: "x"}, {L: "b", R: "x"}}
	if err := verify.CheckCover(edges, []string{"x"}); err != nil {
		t.Fatalf("valid cover rejected: %v", err)
	}
	if err := verify.CheckCover(edges, []string{"a"}); err == nil {
		t.Fatal("invalid cover accepted")
	}
}

func TestCheckEqualSizes(t *testing.T) {
	if err := verify.CheckEqualSizes([]verify.Edge{{L: "a", R: "x"}}, []string{"x"}); err != nil {
		t.Fatalf("equal sizes rejected: %v", err)
	}
	if err := verify.CheckEqualSizes(nil, []string{"x"}); err == nil {
		t.Fatal("unequal sizes accepted")
	}
}

func TestBruteForceReferences(t *testing.T) {
	// Path a-x-b-y (as L/R pairs): min cover 2, max matching 2.
	edges := []verify.Edge{{L: "a", R: "x"}, {L: "x2", R: "x"}, {L: "x2", R: "y"}}
	vertices := []string{"a", "x2", "x", "y"}
	cover, size, err := verify.MinVertexCover(vertices, edges)
	if err != nil {
		t.Fatal(err)
	}
	if size != 2 {
		t.Fatalf("min cover size = %d (%v), want 2", size, cover)
	}
	if got := verify.MaxMatching(edges); got != 2 {
		t.Fatalf("max matching = %d, want 2", got)
	}
	// Empty graph: empty cover, empty matching.
	if _, size, err := verify.MinVertexCover(vertices, nil); err != nil || size != 0 {
		t.Fatalf("empty graph: size %d, err %v", size, err)
	}
	if got := verify.MaxMatching(nil); got != 0 {
		t.Fatalf("empty graph: max matching %d", got)
	}
	// Brute force refuses large inputs.
	if _, _, err := verify.MinVertexCover(make([]string, 25), nil); err == nil {
		t.Fatal("expected refusal for 25 vertices")
	}
}

// TestExhaustiveThreeByThree enumerates all 2^9 bipartite graphs on
// {a,b,c} x {x,y,z} and checks, for each one, that the graph package's
// matching and cover are valid, equally sized, and agree with
// brute-force optima.
func TestExhaustiveThreeByThree(t *testing.T) {
	lefts := []string{"a", "b", "c"}
	rights := []string{"x", "y", "z"}
	for mask := 0; mask < 1<<9; mask++ {
		g := graph.New()
		for _, l := range lefts {
			g.AddVertex(graph.Left, l)
		}
		for _, r := range rights {
			g.AddVertex(graph.Right, r)
		}
		for bit := 0; bit < 9; bit++ {
			if mask&(1<<uint(bit)) != 0 {
				g.AddEdge(lefts[bit/3], rights[bit%3])
			}
		}
		res := g.Analyze()

		var edges []verify.Edge
		for _, e := range g.Edges() {
			edges = append(edges, verify.Edge{L: e.L, R: e.R})
		}
		var matching []verify.Edge
		for _, e := range res.Matching {
			matching = append(matching, verify.Edge{L: e.L, R: e.R})
		}
		if err := verify.CheckMatching(edges, matching); err != nil {
			t.Fatalf("mask %09b: %v", mask, err)
		}
		if err := verify.CheckCover(edges, res.Cover); err != nil {
			t.Fatalf("mask %09b: %v", mask, err)
		}
		if err := verify.CheckEqualSizes(matching, res.Cover); err != nil {
			t.Fatalf("mask %09b: %v", mask, err)
		}
		vertices := append(append([]string{}, lefts...), rights...)
		_, minCover, err := verify.MinVertexCover(vertices, edges)
		if err != nil {
			t.Fatal(err)
		}
		if minCover != len(res.Cover) {
			t.Fatalf("mask %09b: cover size %d, brute-force minimum %d", mask, len(res.Cover), minCover)
		}
		if maxMatch := verify.MaxMatching(edges); maxMatch != len(res.Matching) {
			t.Fatalf("mask %09b: matching size %d, brute-force maximum %d", mask, len(res.Matching), maxMatch)
		}
	}
}
