package dataeng

import "testing"

func TestCompileAndResultAreIndependentOfCallerMutations(t *testing.T) {
	g := &Graph{
		Facts: []string{"a", "b"},
		Root:  "and",
		Nodes: append(
			[]Node{{ID: "and", Kind: NodeAnd, Children: []string{"a", "b"}}},
			literalNodes("a", "b")...,
		),
	}

	compiled, err := Compile(g)
	if err != nil {
		t.Fatalf("Compile returned error: %v", err)
	}
	first := compiled.Shapley()

	g.Facts[0] = "mutated"
	g.Nodes[0].Children[0] = "mutated"
	g.Nodes = append(g.Nodes, Node{ID: "new", Kind: NodeZero})

	second := compiled.Shapley()
	if _, ok := second.Facts["a"]; !ok {
		t.Fatal("compiled graph retained a mutable reference to input facts")
	}

	first.Facts["a"].AWhenFalse[0].SetInt64(123)
	first.Facts["a"].Shapley.SetInt64(123)
	first.RootSupport[0] = "mutated"

	if second.Facts["a"].AWhenFalse[0].Int64() == 123 {
		t.Fatal("returned A arrays alias mutable state across evaluations")
	}
	if second.Facts["a"].Shapley.Sign() <= 0 {
		t.Fatal("returned Shapley value aliases mutable state across evaluations")
	}
	if compiled.RootSupport()[0] != "a" {
		t.Fatal("returned support slice aliases mutable state")
	}
}

func TestEmptyUniverseReturnsEmptyMap(t *testing.T) {
	compiled := mustCompile(t, &Graph{
		Root:  "one",
		Nodes: []Node{{ID: "one", Kind: NodeOne}},
	})
	result := compiled.Shapley()
	if len(result.Facts) != 0 {
		t.Fatalf("len(Facts) = %d, want 0", len(result.Facts))
	}
	if len(result.RootSupport) != 0 {
		t.Fatalf("len(RootSupport) = %d, want 0", len(result.RootSupport))
	}
}
