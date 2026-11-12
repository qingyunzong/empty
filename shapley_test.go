package dataeng

import (
	"math/big"
	"reflect"
	"testing"
)

func literalNode(id string, fact string) Node {
	return Node{
		ID:       id,
		Kind:     NodeDecide,
		Variable: fact,
		Then:     id + "-one",
		Else:     id + "-zero",
	}
}

func assertMatchesReference(t *testing.T, g *Graph) {
	t.Helper()
	compiled, err := Compile(g)
	if err != nil {
		t.Fatalf("Compile returned error: %v", err)
	}

	wantSupport := referenceSupport(g)
	gotSupports := compiled.Supports()
	for id, wantSet := range wantSupport {
		got := gotSupports[id]
		want := make([]string, 0, len(wantSet))
		for _, fact := range g.Facts {
			if wantSet[fact] {
				want = append(want, fact)
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("support[%s] = %v, want %v", id, got, want)
		}
	}

	result := compiled.Shapley()
	if len(g.Facts) == 0 && len(result.Facts) != 0 {
		t.Fatalf("empty universe returned %d facts", len(result.Facts))
	}

	sum := new(big.Rat)
	for _, fact := range g.Facts {
		got := result.Facts[fact]
		wantCounts := referenceCounts(t, g, fact)
		assertBigIntSlicesEqual(t, got.AWhenFalse, wantCounts[0], fact+" A0")
		assertBigIntSlicesEqual(t, got.AWhenTrue, wantCounts[1], fact+" A1")

		wantShapley := referenceShapley(t, g, fact)
		if got.Shapley.Cmp(wantShapley) != 0 {
			t.Fatalf("phi[%s] = %s, want %s", fact, got.Shapley.String(), wantShapley.String())
		}
		sum.Add(sum, got.Shapley)
	}

	emptyAssignment := make(map[string]bool, len(g.Facts))
	fullAssignment := make(map[string]bool, len(g.Facts))
	for _, fact := range g.Facts {
		fullAssignment[fact] = true
	}
	wantSum := new(big.Rat).SetInt64(boolInt(referenceEval(t, g, fullAssignment)) - boolInt(referenceEval(t, g, emptyAssignment)))
	if sum.Cmp(wantSum) != 0 {
		t.Fatalf("sum phi = %s, want %s", sum.String(), wantSum.String())
	}
}

func boolInt(value bool) int64 {
	if value {
		return 1
	}
	return 0
}

func TestShapleyAgainstAllAssignments(t *testing.T) {
	cases := map[string]*Graph{
		"and": {
			Facts: []string{"a", "b"},
			Root:  "and",
			Nodes: append(
				[]Node{
					{ID: "and", Kind: NodeAnd, Children: []string{"a", "b"}},
				},
				literalNodes("a", "b")...,
			),
		},
		"decide asymmetric": {
			Facts: []string{"x", "a", "b", "u"},
			Root:  "d",
			Nodes: append(
				[]Node{
					{ID: "d", Kind: NodeDecide, Variable: "x", Then: "a", Else: "b"},
				},
				literalNodes("a", "b")...,
			),
		},
		"shared subgraph": {
			Facts: []string{"x", "y", "a"},
			Root:  "outer",
			Nodes: append(
				[]Node{
					{ID: "outer", Kind: NodeDecide, Variable: "x", Then: "inner-then", Else: "inner-else"},
					{ID: "inner-then", Kind: NodeDecide, Variable: "y", Then: "a", Else: "zero"},
					{ID: "inner-else", Kind: NodeDecide, Variable: "y", Then: "zero", Else: "a"},
					{ID: "zero", Kind: NodeZero},
				},
				literalNodes("a")...,
			),
		},
		"negative": {
			Facts: []string{"x", "y"},
			Root:  "not-x-and-y",
			Nodes: append(
				[]Node{
					{ID: "not-x", Kind: NodeDecide, Variable: "x", Then: "zero", Else: "one"},
					{ID: "not-x-and-y", Kind: NodeAnd, Children: []string{"not-x", "y"}},
					{ID: "zero", Kind: NodeZero},
					{ID: "one", Kind: NodeOne},
				},
				literalNodes("y")...,
			),
		},
		"empty and constants": {
			Facts: []string{"u"},
			Root:  "empty-and",
			Nodes: []Node{
				{ID: "empty-and", Kind: NodeAnd},
				{ID: "zero", Kind: NodeZero},
			},
		},
		"constant zero": {
			Facts: []string{"u"},
			Root:  "zero",
			Nodes: []Node{{ID: "zero", Kind: NodeZero}},
		},
	}

	for name, graph := range cases {
		t.Run(name, func(t *testing.T) {
			assertMatchesReference(t, graph)
		})
	}
}

func TestTwelveFactsAgainstEveryAssignment(t *testing.T) {
	facts := make([]string, 12)
	nodes := []Node{{ID: "and", Kind: NodeAnd, Children: make([]string, 12)}}
	for i := range facts {
		facts[i] = string(rune('a' + i))
		nodes[0].Children[i] = facts[i]
		nodes = append(nodes, literalNodes(facts[i])...)
	}

	g := &Graph{Facts: facts, Nodes: nodes, Root: "and"}
	assertMatchesReference(t, g)

	compiled := mustCompile(t, g)
	result := compiled.Shapley()
	for _, fact := range facts {
		if result.Facts[fact].Shapley.Cmp(big.NewRat(1, 12)) != 0 {
			t.Fatalf("phi[%s] = %s, want 1/12", fact, result.Facts[fact].Shapley.String())
		}
	}
}

func literalNodes(facts ...string) []Node {
	nodes := make([]Node, 0, len(facts)*3)
	for _, fact := range facts {
		nodes = append(nodes,
			literalNode(fact, fact),
			Node{ID: fact + "-one", Kind: NodeOne},
			Node{ID: fact + "-zero", Kind: NodeZero},
		)
	}
	return nodes
}

func mustCompile(t *testing.T, g *Graph) *CompiledGraph {
	t.Helper()
	compiled, err := Compile(g)
	if err != nil {
		t.Fatalf("Compile returned error: %v", err)
	}
	return compiled
}
