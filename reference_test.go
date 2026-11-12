package dataeng

import (
	"math/big"
	"testing"
)

func referenceEval(t *testing.T, g *Graph, assignment map[string]bool) bool {
	t.Helper()
	nodes := make(map[string]Node, len(g.Nodes))
	for _, node := range g.Nodes {
		nodes[node.ID] = node
	}

	var eval func(string) bool
	eval = func(id string) bool {
		node := nodes[id]
		switch node.Kind {
		case NodeZero:
			return false
		case NodeOne:
			return true
		case NodeAnd:
			for _, child := range node.Children {
				if !eval(child) {
					return false
				}
			}
			return true
		case NodeDecide:
			if assignment[node.Variable] {
				return eval(node.Then)
			}
			return eval(node.Else)
		default:
			t.Fatalf("unknown node kind: %d", node.Kind)
			return false
		}
	}
	return eval(g.Root)
}

func referenceCounts(t *testing.T, g *Graph, fact string) [2][]big.Int {
	t.Helper()
	n := len(g.Facts)
	counts := [2][]big.Int{
		make([]big.Int, n),
		make([]big.Int, n),
	}
	indices := make(map[string]int, n)
	for idx, id := range g.Facts {
		indices[id] = idx
	}
	fixedIndex := indices[fact]

	for mask := 0; mask < 1<<n; mask++ {
		if mask&(1<<fixedIndex) != 0 {
			continue
		}
		assignment := make(map[string]bool, n)
		for idx, id := range g.Facts {
			assignment[id] = mask&(1<<idx) != 0
		}

		assignment[fact] = false
		if referenceEval(t, g, assignment) {
			counts[0][popCount(mask)].Add(&counts[0][popCount(mask)], big.NewInt(1))
		}

		assignment[fact] = true
		if referenceEval(t, g, assignment) {
			counts[1][popCount(mask)].Add(&counts[1][popCount(mask)], big.NewInt(1))
		}
	}
	return counts
}

func referenceShapley(t *testing.T, g *Graph, fact string) *big.Rat {
	t.Helper()
	counts := referenceCounts(t, g, fact)
	n := len(g.Facts)
	result := new(big.Rat)
	numerator := new(big.Int)
	for k := 0; k < n; k++ {
		numerator.Sub(&counts[1][k], &counts[0][k])
		numerator.Mul(numerator, &factorial[k])
		numerator.Mul(numerator, &factorial[n-k-1])
		result.Add(result, new(big.Rat).SetFrac(numerator, &factorial[n]))
	}
	return result
}

func referenceSupport(g *Graph) map[string]map[string]bool {
	nodes := make(map[string]Node, len(g.Nodes))
	for _, node := range g.Nodes {
		nodes[node.ID] = node
	}
	memo := make(map[string]map[string]bool)

	var support func(string) map[string]bool
	support = func(id string) map[string]bool {
		if result, ok := memo[id]; ok {
			return result
		}
		node := nodes[id]
		result := make(map[string]bool)
		switch node.Kind {
		case NodeAnd:
			for _, child := range node.Children {
				for fact := range support(child) {
					result[fact] = true
				}
			}
		case NodeDecide:
			for fact := range support(node.Then) {
				result[fact] = true
			}
			for fact := range support(node.Else) {
				result[fact] = true
			}
			result[node.Variable] = true
		}
		memo[id] = result
		return result
	}

	all := make(map[string]map[string]bool, len(g.Nodes))
	for id := range nodes {
		all[id] = support(id)
	}
	return all
}

func popCount(mask int) int {
	count := 0
	for mask != 0 {
		mask &= mask - 1
		count++
	}
	return count
}

func assertBigIntSlicesEqual(t *testing.T, got, want []big.Int, label string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s length = %d, want %d", label, len(got), len(want))
	}
	for k := range want {
		if got[k].Cmp(&want[k]) != 0 {
			t.Fatalf("%s[%d] = %s, want %s", label, k, got[k].String(), want[k].String())
		}
	}
}
