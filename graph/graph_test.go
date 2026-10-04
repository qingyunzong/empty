package graph_test

import (
	"math/rand"
	"reflect"
	"testing"

	"graphlib/graph"
	"graphlib/verify"
)

func toVerify(edges []graph.Edge) []verify.Edge {
	out := make([]verify.Edge, len(edges))
	for i, e := range edges {
		out[i] = verify.Edge{L: e.L, R: e.R}
	}
	return out
}

// checkResult independently verifies one Analyze result: the matching
// and cover must be valid, have equal size, and match brute-force
// optima for the current edge set.
func checkResult(t *testing.T, g *graph.Graph, res graph.Result) {
	t.Helper()
	edges := toVerify(g.Edges())
	matching := toVerify(res.Matching)
	if err := verify.CheckMatching(edges, matching); err != nil {
		t.Fatalf("version %d: %v", res.Version, err)
	}
	if err := verify.CheckCover(edges, res.Cover); err != nil {
		t.Fatalf("version %d: %v", res.Version, err)
	}
	if err := verify.CheckEqualSizes(matching, res.Cover); err != nil {
		t.Fatalf("version %d: %v", res.Version, err)
	}
	vertices := append(g.Vertices(graph.Left), g.Vertices(graph.Right)...)
	_, minCover, err := verify.MinVertexCover(vertices, edges)
	if err != nil {
		t.Fatalf("version %d: %v", res.Version, err)
	}
	if minCover != len(res.Cover) {
		t.Fatalf("version %d: cover size %d, brute-force minimum %d (edges %v)",
			res.Version, len(res.Cover), minCover, edges)
	}
	if maxMatch := verify.MaxMatching(edges); maxMatch != len(res.Matching) {
		t.Fatalf("version %d: matching size %d, brute-force maximum %d (edges %v)",
			res.Version, len(res.Matching), maxMatch, edges)
	}
}

func TestEditsUndoAndVersions(t *testing.T) {
	g := graph.New()
	g.AddVertex(graph.Left, "l_iso")
	g.AddVertex(graph.Right, "r_iso")
	if g.Version() != 0 {
		t.Fatalf("vertex registration must not create a version, got %d", g.Version())
	}
	g.AddEdge("a", "x")
	g.AddEdge("b", "x")
	g.AddEdge("b", "y")
	if g.Version() != 3 {
		t.Fatalf("version = %d, want 3", g.Version())
	}
	want := g.Edges()

	g.RemoveEdge("b", "x")
	if g.Version() != 4 {
		t.Fatalf("version = %d, want 4", g.Version())
	}
	if !g.Undo() {
		t.Fatal("undo failed")
	}
	if got := g.Edges(); !reflect.DeepEqual(got, want) {
		t.Fatalf("undo did not restore edge set: got %v, want %v", got, want)
	}

	for g.Undo() {
	}
	if len(g.Edges()) != 0 {
		t.Fatalf("undoing all edits should leave no edges, got %v", g.Edges())
	}
	if g.Undo() {
		t.Fatal("undo on empty history should report false")
	}
	// Isolated vertices survive edge removal and undo.
	if got := g.Vertices(graph.Left); !reflect.DeepEqual(got, []string{"a", "b", "l_iso"}) {
		t.Fatalf("left vertices = %v", got)
	}
	if got := g.Vertices(graph.Right); !reflect.DeepEqual(got, []string{"r_iso", "x", "y"}) {
		t.Fatalf("right vertices = %v", got)
	}
}

func TestDuplicateAndMissingEdges(t *testing.T) {
	g := graph.New()
	if !g.AddEdge("a", "x") {
		t.Fatal("first AddEdge should change the graph")
	}
	if g.AddEdge("a", "x") {
		t.Fatal("duplicate AddEdge should be a no-op")
	}
	if g.Version() != 1 || len(g.Edges()) != 1 {
		t.Fatalf("duplicate edge changed state: version %d, edges %v", g.Version(), g.Edges())
	}
	if !g.RemoveEdge("a", "x") {
		t.Fatal("RemoveEdge of existing edge should succeed")
	}
	if g.RemoveEdge("a", "x") {
		t.Fatal("RemoveEdge of missing edge should be a no-op")
	}
	if g.Version() != 2 {
		t.Fatalf("version = %d, want 2", g.Version())
	}
	if !g.Undo() || len(g.Edges()) != 1 {
		t.Fatal("undo should restore the removed edge")
	}
	if !g.Undo() || len(g.Edges()) != 0 {
		t.Fatal("second undo should remove the originally added edge")
	}
}

func TestKnownGraphs(t *testing.T) {
	cases := []struct {
		name  string
		edges [][2]string
		size  int
	}{
		{"empty", nil, 0},
		{"single", [][2]string{{"a", "x"}}, 1},
		{"path3", [][2]string{{"a", "x"}, {"b", "x"}, {"b", "y"}}, 2},
		{"star", [][2]string{{"a", "x"}, {"a", "y"}, {"a", "z"}}, 1},
		{"K2x3", [][2]string{{"a", "x"}, {"a", "y"}, {"a", "z"}, {"b", "x"}, {"b", "y"}, {"b", "z"}}, 2},
		{"K3x3", [][2]string{{"a", "x"}, {"a", "y"}, {"a", "z"}, {"b", "x"}, {"b", "y"}, {"b", "z"}, {"c", "x"}, {"c", "y"}, {"c", "z"}}, 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := graph.New()
			g.AddVertex(graph.Left, "isolated_l")
			g.AddVertex(graph.Right, "isolated_r")
			for _, e := range tc.edges {
				g.AddEdge(e[0], e[1])
			}
			res := g.Analyze()
			if len(res.Matching) != tc.size || len(res.Cover) != tc.size {
				t.Fatalf("got matching %v cover %v, want size %d", res.Matching, res.Cover, tc.size)
			}
			checkResult(t, g, res)
		})
	}
}

func TestRandomizedAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	lefts := []string{"l0", "l1", "l2", "l3"}
	rights := []string{"r0", "r1", "r2", "r3"}
	for trial := 0; trial < 100; trial++ {
		g := graph.New()
		for _, l := range lefts {
			g.AddVertex(graph.Left, l)
		}
		for _, r := range rights {
			g.AddVertex(graph.Right, r)
		}
		for step := 0; step < 40; step++ {
			switch rng.Intn(4) {
			case 0, 1:
				g.AddEdge(lefts[rng.Intn(len(lefts))], rights[rng.Intn(len(rights))])
			case 2:
				g.RemoveEdge(lefts[rng.Intn(len(lefts))], rights[rng.Intn(len(rights))])
			case 3:
				g.Undo()
			}
			checkResult(t, g, g.Analyze())
		}
		for g.Undo() {
		}
		if len(g.Edges()) != 0 {
			t.Fatalf("trial %d: undoing all edits left edges %v", trial, g.Edges())
		}
	}
}
