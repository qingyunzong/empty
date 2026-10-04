package checker

import (
	"errors"
	"testing"
)

func TestCheckAcyclic(t *testing.T) {
	nodes := []string{"a", "b", "c", "d"}
	edges := []Edge{{"a", "b"}, {"a", "c"}, {"b", "d"}, {"c", "d"}, {"b", "d"}} // dup ignored
	if err := Check(nodes, edges); err != nil {
		t.Fatalf("Check: %v", err)
	}
}

func TestCheckCycleEvidence(t *testing.T) {
	nodes := []string{"a", "b", "c"}
	edges := []Edge{{"a", "b"}, {"b", "c"}, {"c", "a"}}
	err := Check(nodes, edges)
	var cyc *CycleError
	if !errors.As(err, &cyc) {
		t.Fatalf("expected *CycleError, got %v", err)
	}
	p := cyc.Path
	if len(p) != 4 || p[0] != p[3] {
		t.Fatalf("cycle path = %v, want a 3-node closed cycle", p)
	}
	have := map[Edge]bool{}
	for _, e := range edges {
		have[e] = true
	}
	for i := 0; i+1 < len(p); i++ {
		if !have[Edge{p[i], p[i+1]}] {
			t.Fatalf("cycle path %v uses non-existent edge %s->%s", p, p[i], p[i+1])
		}
	}
}

func TestCheckSelfLoop(t *testing.T) {
	var cyc *CycleError
	if err := Check([]string{"a"}, []Edge{{"a", "a"}}); !errors.As(err, &cyc) {
		t.Fatalf("expected *CycleError, got %v", err)
	}
}

func TestCheckUnknownAndDuplicateNodes(t *testing.T) {
	if err := Check([]string{"a"}, []Edge{{"a", "b"}}); err == nil {
		t.Fatal("expected error for unknown endpoint")
	}
	if err := Check([]string{"a", "a"}, nil); err == nil {
		t.Fatal("expected error for duplicate node")
	}
}
