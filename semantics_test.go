package dataeng

import (
	"math/big"
	"testing"
)

func asymmetricGraph() *Graph {
	return &Graph{
		Facts: []string{"x", "a", "b", "u"},
		Root:  "d",
		Nodes: append(
			[]Node{
				{ID: "d", Kind: NodeDecide, Variable: "x", Then: "a", Else: "b"},
			},
			literalNodes("a", "b")...,
		),
	}
}

func TestAsymmetricBranchFreeVariablePadding(t *testing.T) {
	compiled := mustCompile(t, asymmetricGraph())
	result := compiled.Shapley()

	x := result.Facts["x"]
	wantXFalse := []int64{0, 1, 2, 1}
	wantXTrue := []int64{0, 1, 2, 1}
	assertInt64Counts(t, x.AWhenFalse, wantXFalse, "x A0")
	assertInt64Counts(t, x.AWhenTrue, wantXTrue, "x A1")
	if x.Shapley.Sign() != 0 {
		t.Fatalf("phi[x] = %s, want 0", x.Shapley.String())
	}

	a := result.Facts["a"]
	wantAFalse := []int64{0, 1, 1, 0}
	wantATrue := []int64{0, 2, 3, 1}
	assertInt64Counts(t, a.AWhenFalse, wantAFalse, "a A0")
	assertInt64Counts(t, a.AWhenTrue, wantATrue, "a A1")

	b := result.Facts["b"]
	wantBFalse := []int64{0, 0, 1, 1}
	wantBTrue := []int64{1, 2, 2, 1}
	assertInt64Counts(t, b.AWhenFalse, wantBFalse, "b A0")
	assertInt64Counts(t, b.AWhenTrue, wantBTrue, "b A1")

	assertInt64Counts(t, a.AWhenFalse, []int64{0, 1, 1, 0}, "a fixed false")
	assertInt64Counts(t, a.AWhenTrue, []int64{0, 2, 3, 1}, "a fixed true")
	assertInt64Counts(t, b.AWhenFalse, []int64{0, 0, 1, 1}, "b fixed false")
	assertInt64Counts(t, b.AWhenTrue, []int64{1, 2, 2, 1}, "b fixed true")

	u := result.Facts["u"]
	wantU := []int64{0, 1, 2, 1}
	assertInt64Counts(t, u.AWhenFalse, wantU, "u A0")
	assertInt64Counts(t, u.AWhenTrue, wantU, "u A1")
	if u.Shapley.Sign() != 0 {
		t.Fatalf("phi[u] = %s, want 0", u.Shapley.String())
	}
}

func TestFixedDecisionKeepsUnselectedBranchVariablesFree(t *testing.T) {
	compiled := mustCompile(t, asymmetricGraph())
	result := compiled.Shapley()

	x := result.Facts["x"]
	assertInt64Counts(t, x.AWhenFalse, []int64{0, 1, 2, 1}, "x fixed false")
	assertInt64Counts(t, x.AWhenTrue, []int64{0, 1, 2, 1}, "x fixed true")

	rootSupport := compiled.RootSupport()
	wantSupport := []string{"x", "a", "b"}
	if len(rootSupport) != len(wantSupport) {
		t.Fatalf("root support = %v, want %v", rootSupport, wantSupport)
	}
	for i := range wantSupport {
		if rootSupport[i] != wantSupport[i] {
			t.Fatalf("root support = %v, want %v", rootSupport, wantSupport)
		}
	}
}

func TestNegativeContributionIsPreserved(t *testing.T) {
	g := &Graph{
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
	}
	compiled := mustCompile(t, g)
	result := compiled.Shapley()
	negativeHalf := big.NewRat(-1, 2)
	if result.Facts["x"].Shapley.Cmp(negativeHalf) != 0 {
		t.Fatalf("phi[x] = %s, want -1/2", result.Facts["x"].Shapley.String())
	}
	assertInt64Counts(t, result.Facts["x"].AWhenFalse, []int64{0, 1}, "not x A0")
	assertInt64Counts(t, result.Facts["x"].AWhenTrue, []int64{0, 0}, "not x A1")
}

func TestSharedNodeReusedByBothDecisionBranches(t *testing.T) {
	g := &Graph{
		Facts: []string{"x", "a", "b"},
		Root:  "d",
		Nodes: append(
			[]Node{
				{ID: "d", Kind: NodeDecide, Variable: "x", Then: "shared", Else: "shared"},
				{ID: "shared", Kind: NodeAnd, Children: []string{"a", "b"}},
			},
			literalNodes("a", "b")...,
		),
	}
	compiled := mustCompile(t, g)
	result := compiled.Shapley()

	x := result.Facts["x"]
	wantX := []int64{0, 0, 1}
	assertInt64Counts(t, x.AWhenFalse, wantX, "x A0")
	assertInt64Counts(t, x.AWhenTrue, wantX, "x A1")
	if x.Shapley.Sign() != 0 {
		t.Fatalf("phi[x] = %s, want 0", x.Shapley.String())
	}

	a := result.Facts["a"]
	assertInt64Counts(t, a.AWhenFalse, []int64{0, 0, 0}, "a A0")
	assertInt64Counts(t, a.AWhenTrue, []int64{0, 1, 1}, "a A1")
	if a.Shapley.Cmp(big.NewRat(1, 2)) != 0 {
		t.Fatalf("phi[a] = %s, want 1/2", a.Shapley.String())
	}
}

func assertInt64Counts(t *testing.T, got []big.Int, want []int64, label string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s length = %d, want %d", label, len(got), len(want))
	}
	for k := range want {
		if got[k].Int64() != want[k] {
			t.Fatalf("%s[%d] = %d, want %d", label, k, got[k].Int64(), want[k])
		}
	}
}
