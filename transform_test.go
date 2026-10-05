package graphtest

import (
	"strings"
	"testing"
)

func pathGraph(t *testing.T) *Graph {
	t.Helper()
	g := NewGraph()
	for _, e := range [][2]int{{1, 2}, {2, 3}} {
		if err := g.AddEdge(e[0], e[1]); err != nil {
			t.Fatalf("AddEdge: %v", err)
		}
	}
	return g
}

func TestRelabelApplyAndMaps(t *testing.T) {
	g := pathGraph(t)
	tr := Relabel(map[int]int{1: 10, 2: 20, 3: 30})
	h, err := tr.Apply(g)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !h.HasEdge(10, 20) || !h.HasEdge(20, 30) || h.HasEdge(1, 2) {
		t.Fatalf("relabel produced wrong edges: %v", h.Edges())
	}
	fwd, err := tr.ForwardMap(g)
	if err != nil {
		t.Fatalf("ForwardMap: %v", err)
	}
	if fwd[1] != 10 || fwd[2] != 20 || fwd[3] != 30 {
		t.Fatalf("forward map wrong: %v", fwd)
	}
	inv, err := tr.InverseMap(g)
	if err != nil {
		t.Fatalf("InverseMap: %v", err)
	}
	for old, nv := range fwd {
		if inv[nv] != old {
			t.Fatalf("inverse map not the inverse of forward map")
		}
	}
}

func TestRelabelIllegal(t *testing.T) {
	g := pathGraph(t)
	cases := []struct {
		name string
		perm map[int]int
		want string
	}{
		{"collision", map[int]int{1: 7, 2: 7, 3: 8}, "bijection"},
		{"missing vertex", map[int]int{1: 10, 2: 20}, "covers"},
		{"extra vertex", map[int]int{1: 10, 2: 20, 3: 30, 4: 40}, "covers"},
	}
	for _, tc := range cases {
		if _, err := Relabel(tc.perm).Apply(g); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: got %v, want error containing %q", tc.name, err, tc.want)
		}
	}
}

func TestAddIsolated(t *testing.T) {
	g := pathGraph(t)
	tr := AddIsolated(50, 60)
	h, err := tr.Apply(g)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if h.NumVertices() != 5 || h.NumEdges() != 2 {
		t.Fatalf("got %d vertices, %d edges; want 5, 2", h.NumVertices(), h.NumEdges())
	}
	if len(h.Neighbors(50)) != 0 || len(h.Neighbors(60)) != 0 {
		t.Fatalf("added vertices are not isolated")
	}
	fwd, err := tr.ForwardMap(g)
	if err != nil {
		t.Fatalf("ForwardMap: %v", err)
	}
	for _, v := range []int{1, 2, 3} {
		if fwd[v] != v {
			t.Fatalf("forward map should be identity on existing vertices, got %v", fwd)
		}
	}
	if _, err := AddIsolated(2).Apply(g); err == nil {
		t.Fatalf("adding an existing vertex accepted")
	}
	if _, err := AddIsolated(7, 7).Apply(g); err == nil {
		t.Fatalf("duplicate vertices accepted")
	}
	if _, err := AddIsolated().Apply(g); err == nil {
		t.Fatalf("empty addition accepted")
	}
}

func TestSplitEdge(t *testing.T) {
	g := pathGraph(t)
	tr := SplitEdge(1, 2, 90)
	h, err := tr.Apply(g)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if h.HasEdge(1, 2) {
		t.Fatalf("original edge still present")
	}
	if !h.HasEdge(1, 90) || !h.HasEdge(90, 2) {
		t.Fatalf("split edges missing: %v", h.Edges())
	}
	if h.NumVertices() != 4 || h.NumEdges() != 3 {
		t.Fatalf("got %d vertices, %d edges; want 4, 3", h.NumVertices(), h.NumEdges())
	}
	if _, err := SplitEdge(1, 3, 91).Apply(g); err == nil {
		t.Fatalf("splitting a non-edge accepted")
	}
	if _, err := SplitEdge(1, 2, 3).Apply(g); err == nil {
		t.Fatalf("splitting with an existing midpoint accepted")
	}
}

func TestUnknownKindRejected(t *testing.T) {
	g := pathGraph(t)
	if _, err := (Transform{Kind: "frobnicate"}).Apply(g); err == nil {
		t.Fatalf("unknown kind accepted")
	}
}
