package graph

import (
	"errors"
	"reflect"
	"testing"
)

func TestVersionedAddRemoveUndo(t *testing.T) {
	g := New()
	if g.Version() != 0 {
		t.Fatalf("initial version = %d, want 0", g.Version())
	}
	if v, err := g.AddEdge("a", "x"); err != nil || v != 1 {
		t.Fatalf("AddEdge -> (%d, %v), want (1, nil)", v, err)
	}
	if v, err := g.AddEdge("b", "x"); err != nil || v != 2 {
		t.Fatalf("AddEdge -> (%d, %v), want (2, nil)", v, err)
	}
	if v, ok := g.RemoveEdge("a", "x"); !ok || v != 3 {
		t.Fatalf("RemoveEdge -> (%d, %v), want (3, true)", v, ok)
	}
	if g.Has("a", "x") || !g.Has("b", "x") {
		t.Fatalf("unexpected edge set after remove: %v", g.Edges())
	}
	// Undo the removal, then undo both insertions.
	for i, want := range []struct {
		version int
		edges   []Edge
	}{
		{4, []Edge{{"a", "x"}, {"b", "x"}}},
		{5, []Edge{{"a", "x"}}},
		{6, nil},
	} {
		v, ok := g.Undo()
		if !ok || v != want.version {
			t.Fatalf("undo %d -> (%d, %v), want (%d, true)", i, v, ok, want.version)
		}
		if got := g.Edges(); !reflect.DeepEqual(got, want.edges) && !(got == nil && want.edges == nil) {
			t.Fatalf("undo %d edges = %v, want %v", i, got, want.edges)
		}
	}
	if v, ok := g.Undo(); ok || v != 6 {
		t.Fatalf("Undo on empty log -> (%d, %v), want (6, false)", v, ok)
	}
}

func TestDuplicateEdgeIsIdempotent(t *testing.T) {
	g := New()
	g.AddEdge("a", "b")
	v, err := g.AddEdge("a", "b")
	if err != nil || v != 1 {
		t.Fatalf("duplicate AddEdge -> (%d, %v), want (1, nil)", v, err)
	}
	v, err = g.AddEdge("b", "a") // reversed order is the same edge
	if err != nil || v != 1 {
		t.Fatalf("reversed duplicate AddEdge -> (%d, %v), want (1, nil)", v, err)
	}
	if got := g.Edges(); len(got) != 1 {
		t.Fatalf("edges = %v, want exactly one", got)
	}
	// A single undo must remove the edge: it was inserted only once.
	if _, ok := g.Undo(); !ok {
		t.Fatal("Undo failed")
	}
	if g.Has("a", "b") {
		t.Fatal("edge still present after undoing its single insertion")
	}
}

func TestIsolatedVerticesKeepStableIDs(t *testing.T) {
	g := New()
	g.AddVertex("lonely")
	g.AddVertex("lonely") // idempotent
	g.AddEdge("a", "b")
	g.RemoveEdge("a", "b") // a and b become isolated but stay registered
	want := []string{"a", "b", "lonely"}
	if got := g.Vertices(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Vertices = %v, want %v", got, want)
	}
	a := g.Analyze()
	if len(a.Matching) != 0 || len(a.Cover) != 0 {
		t.Fatalf("edgeless graph: matching=%v cover=%v, want both empty", a.Matching, a.Cover)
	}
}

func TestRemoveMissingEdge(t *testing.T) {
	g := New()
	if v, ok := g.RemoveEdge("a", "b"); ok || v != 0 {
		t.Fatalf("RemoveEdge missing -> (%d, %v), want (0, false)", v, ok)
	}
}

func TestSelfLoopRejected(t *testing.T) {
	g := New()
	if _, err := g.AddEdge("a", "a"); !errors.Is(err, ErrSelfLoop) {
		t.Fatalf("AddEdge self-loop err = %v, want ErrSelfLoop", err)
	}
	if g.Version() != 0 {
		t.Fatalf("version bumped by rejected edge: %d", g.Version())
	}
}

func TestNonBipartiteRejected(t *testing.T) {
	g := New()
	g.AddEdge("a", "b")
	g.AddEdge("b", "c")
	if _, err := g.AddEdge("c", "a"); !errors.Is(err, ErrNotBipartite) {
		t.Fatalf("closing a triangle err = %v, want ErrNotBipartite", err)
	}
	if g.Version() != 2 || len(g.Edges()) != 2 {
		t.Fatalf("rejected edge mutated the graph: version=%d edges=%v", g.Version(), g.Edges())
	}
}

func TestKnownAnalyses(t *testing.T) {
	cases := []struct {
		name  string
		edges []Edge
		size  int
	}{
		{"path P4", []Edge{{"a", "b"}, {"b", "c"}, {"c", "d"}}, 2},
		{"star K1,3", []Edge{{"c", "x"}, {"c", "y"}, {"c", "z"}}, 1},
		{"cycle C6", []Edge{{"1", "2"}, {"2", "3"}, {"3", "4"}, {"4", "5"}, {"5", "6"}, {"6", "1"}}, 3},
		{"perfect K3,3", []Edge{
			{"a", "x"}, {"a", "y"}, {"a", "z"},
			{"b", "x"}, {"b", "y"}, {"b", "z"},
			{"c", "x"}, {"c", "y"}, {"c", "z"},
		}, 3},
		{"single edge", []Edge{{"u", "v"}}, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := New()
			for _, e := range tc.edges {
				if _, err := g.AddEdge(e.U, e.V); err != nil {
					t.Fatalf("AddEdge(%s,%s): %v", e.U, e.V, err)
				}
			}
			a := g.Analyze()
			if len(a.Matching) != tc.size || len(a.Cover) != tc.size {
				t.Fatalf("matching=%d cover=%d, want both %d", len(a.Matching), len(a.Cover), tc.size)
			}
			if a.Version != g.Version() {
				t.Fatalf("analysis version %d != graph version %d", a.Version, g.Version())
			}
		})
	}
}

func TestAnalyzeCachedPerVersion(t *testing.T) {
	g := New()
	g.AddEdge("a", "b")
	a1 := g.Analyze()
	a2 := g.Analyze()
	if !reflect.DeepEqual(a1, a2) {
		t.Fatalf("cached analysis differs: %v vs %v", a1, a2)
	}
	g.AddEdge("c", "d")
	a3 := g.Analyze()
	if a3.Version != a2.Version+1 || len(a3.Matching) != 2 {
		t.Fatalf("stale cache after mutation: %+v", a3)
	}
}

func TestUndoRestoresAnalysis(t *testing.T) {
	g := New()
	g.AddEdge("a", "x")
	g.AddEdge("b", "y")
	before := g.Analyze()
	g.AddEdge("a", "y")
	g.Undo()
	after := g.Analyze()
	if !reflect.DeepEqual(before.Matching, after.Matching) || !reflect.DeepEqual(before.Cover, after.Cover) {
		t.Fatalf("undo did not restore analysis: %+v vs %+v", before, after)
	}
}
