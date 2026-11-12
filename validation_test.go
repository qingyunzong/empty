package dataeng

import (
	"math/big"
	"testing"
)

func TestCompileRejectsInvalidGraphs(t *testing.T) {
	baseFacts := []string{"a", "b"}

	cases := map[string]*Graph{
		"duplicate facts": {
			Facts: []string{"a", "a"},
			Root:  "zero",
			Nodes: []Node{{ID: "zero", Kind: NodeZero}},
		},
		"duplicate nodes": {
			Facts: baseFacts,
			Root:  "zero",
			Nodes: []Node{
				{ID: "zero", Kind: NodeZero},
				{ID: "zero", Kind: NodeOne},
			},
		},
		"missing root": {
			Facts: baseFacts,
			Root:  "missing",
			Nodes: []Node{{ID: "zero", Kind: NodeZero}},
		},
		"missing and child": {
			Facts: baseFacts,
			Root:  "and",
			Nodes: []Node{{ID: "and", Kind: NodeAnd, Children: []string{"missing"}}},
		},
		"missing decide branch": {
			Facts: baseFacts,
			Root:  "d",
			Nodes: []Node{{ID: "d", Kind: NodeDecide, Variable: "a", Then: "one", Else: "missing"}},
		},
		"unknown decide variable": {
			Facts: baseFacts,
			Root:  "d",
			Nodes: []Node{
				{ID: "d", Kind: NodeDecide, Variable: "missing", Then: "one", Else: "zero"},
				{ID: "one", Kind: NodeOne},
				{ID: "zero", Kind: NodeZero},
			},
		},
		"cycle": {
			Facts: baseFacts,
			Root:  "a-and",
			Nodes: []Node{
				{ID: "a-and", Kind: NodeAnd, Children: []string{"b-and"}},
				{ID: "b-and", Kind: NodeAnd, Children: []string{"a-and"}},
			},
		},
		"overlapping and support": {
			Facts: baseFacts,
			Root:  "outer",
			Nodes: append(
				[]Node{
					{ID: "outer", Kind: NodeAnd, Children: []string{"left", "right"}},
					{ID: "left", Kind: NodeAnd, Children: []string{"a"}},
					{ID: "right", Kind: NodeAnd, Children: []string{"a", "b"}},
				},
				literalNodes("a", "b")...,
			),
		},
		"decision variable hidden in then": {
			Facts: baseFacts,
			Root:  "d",
			Nodes: append(
				[]Node{
					{ID: "d", Kind: NodeDecide, Variable: "a", Then: "a", Else: "b"},
				},
				literalNodes("a", "b")...,
			),
		},
		"decision variable hidden in else": {
			Facts: baseFacts,
			Root:  "d",
			Nodes: append(
				[]Node{
					{ID: "d", Kind: NodeDecide, Variable: "b", Then: "a", Else: "b"},
				},
				literalNodes("a", "b")...,
			),
		},
	}

	for name, graph := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Compile(graph); err == nil {
				t.Fatal("Compile succeeded, want error")
			}
		})
	}
}

func TestLargeSixtyFactGraphs(t *testing.T) {
	t.Run("and", func(t *testing.T) {
		facts := factNames(60)
		nodes := []Node{{ID: "and", Kind: NodeAnd, Children: append([]string(nil), facts...)}}
		for _, fact := range facts {
			nodes = append(nodes, literalNodes(fact)...)
		}

		compiled := mustCompile(t, &Graph{Facts: facts, Nodes: nodes, Root: "and"})
		result := compiled.Shapley()
		want := big.NewRat(1, 60)
		zero := big.NewInt(0)

		for idx, fact := range facts {
			got := result.Facts[fact]
			if got.Shapley.Cmp(want) != 0 {
				t.Fatalf("phi[%s] = %s, want 1/60", fact, got.Shapley.String())
			}
			if len(got.AWhenFalse) != 60 || len(got.AWhenTrue) != 60 {
				t.Fatalf("A lengths for %s = %d/%d, want 60", fact, len(got.AWhenFalse), len(got.AWhenTrue))
			}
			if got.AWhenFalse[0].Cmp(zero) != 0 {
				t.Fatalf("A0[0][%s] = %s, want 0", fact, got.AWhenFalse[0].String())
			}
			if idx == 0 {
				if got.AWhenTrue[59].Cmp(big.NewInt(1)) != 0 {
					t.Fatalf("A1[59] = %s, want 1", got.AWhenTrue[59].String())
				}
			}
		}
	})

	t.Run("or decision chain", func(t *testing.T) {
		facts := factNames(60)
		nodes := orDecisionChain(facts)
		compiled := mustCompile(t, &Graph{Facts: facts, Nodes: nodes, Root: "d0"})
		result := compiled.Shapley()
		want := big.NewRat(1, 60)

		for _, fact := range facts {
			got := result.Facts[fact]
			if got.Shapley.Cmp(want) != 0 {
				t.Fatalf("phi[%s] = %s, want 1/60", fact, got.Shapley.String())
			}
		}

		first := result.Facts[facts[0]]
		if first.AWhenFalse[59].Cmp(big.NewInt(1)) != 0 {
			t.Fatalf("A0[59] = %s, want 1", first.AWhenFalse[59].String())
		}
		if first.AWhenTrue[0].Cmp(big.NewInt(1)) != 0 {
			t.Fatalf("A1[0] = %s, want 1", first.AWhenTrue[0].String())
		}
	})
}

func factNames(n int) []string {
	facts := make([]string, n)
	for i := range facts {
		facts[i] = "f" + itoa(i)
	}
	return facts
}

func orDecisionChain(facts []string) []Node {
	nodes := make([]Node, 0, len(facts)*3)
	for i, fact := range facts {
		elseID := "zero"
		if i+1 < len(facts) {
			elseID = "d" + itoa(i+1)
		}
		nodes = append(nodes, Node{
			ID:       "d" + itoa(i),
			Kind:     NodeDecide,
			Variable: fact,
			Then:     "one",
			Else:     elseID,
		})
	}
	nodes = append(nodes,
		Node{ID: "zero", Kind: NodeZero},
		Node{ID: "one", Kind: NodeOne},
	)
	return nodes
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
