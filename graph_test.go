package graphtest

import "testing"

func TestGraphBasics(t *testing.T) {
	g := NewGraph()
	if err := g.AddEdge(1, 2); err != nil {
		t.Fatalf("AddEdge: %v", err)
	}
	if err := g.AddEdge(2, 3); err != nil {
		t.Fatalf("AddEdge: %v", err)
	}
	g.AddVertex(9)
	if g.NumVertices() != 4 || g.NumEdges() != 2 {
		t.Fatalf("got %d vertices, %d edges; want 4, 2", g.NumVertices(), g.NumEdges())
	}
	if !g.HasEdge(2, 1) || !g.HasEdge(3, 2) || g.HasEdge(1, 3) {
		t.Fatalf("edge queries wrong")
	}
	if err := g.AddEdge(5, 5); err == nil {
		t.Fatalf("self-loop accepted")
	}
	c := g.Clone()
	if !g.Equal(c) {
		t.Fatalf("clone not equal")
	}
	c.AddVertex(100)
	if g.Equal(c) || g.HasVertex(100) {
		t.Fatalf("clone not deep")
	}
}
