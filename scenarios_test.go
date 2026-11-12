package dataeng

import (
	"math/big"
	"testing"
)

// TestDiamondIncomparableMiddles covers a diamond partial order whose two
// middle nodes are incomparable and must retain different optimal values.
func TestDiamondIncomparableMiddles(t *testing.T) {
	ids := []string{"b", "l", "r", "t"}
	y := []*big.Rat{testRat("0"), testRat("5"), testRat("9"), testRat("10")}
	w := []*big.Rat{testRat("1"), testRat("1"), testRat("1"), testRat("1")}
	edges := []Edge{
		{EdgeID: "e1", From: "b", To: "l"},
		{EdgeID: "e2", From: "b", To: "r"},
		{EdgeID: "e3", From: "l", To: "t"},
		{EdgeID: "e4", From: "r", To: "t"},
	}
	g := mustCompile(t, ids, y, w, edges)
	res, err := g.Solve(y, w)
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	assertVectorMatchesReference(t, g, y, w, res)
	assertCertificateValid(t, buildCertificate(t, g, y, w, res))

	if res.x[1].Cmp(res.x[2]) == 0 {
		t.Fatalf("incomparable middles were forced equal: both %s", res.x[1].RatString())
	}
	if res.x[0].Cmp(res.x[1]) > 0 || res.x[2].Cmp(res.x[3]) > 0 {
		t.Fatalf("diamond ordering violated: %v", res.x)
	}
	if res.FlowCalls() == 0 {
		t.Fatalf("expected recorded flow calls")
	}

	// A non-tight edge must carry a zero multiplier.
	for k, e := range g.edges {
		gap := new(big.Rat).Sub(res.x[e.from], res.x[e.to])
		if gap.Sign() < 0 && res.lambda[k].Sign() != 0 {
			t.Fatalf("non-tight edge %d has positive multiplier %s", k, res.lambda[k].RatString())
		}
	}
}

func TestEmptyGraphAndIsolatedNodes(t *testing.T) {
	g, err := Compile(nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("compile empty: %v", err)
	}
	res, err := g.Solve(nil, nil)
	if err != nil {
		t.Fatalf("solve empty: %v", err)
	}
	if g.N() != 0 || res.Blocks() != 0 || res.F().Sign() != 0 || len(res.x) != 0 {
		t.Fatalf("empty graph must return empty vector and zero")
	}

	ids := []string{"iso", "a", "b"}
	y := []*big.Rat{testRat("7/3"), testRat("0"), testRat("10")}
	w := []*big.Rat{testRat("2"), testRat("1"), testRat("1")}
	edges := []Edge{{EdgeID: "ab", From: "a", To: "b"}}
	g = mustCompile(t, ids, y, w, edges)
	res, err = g.Solve(y, w)
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	assertVectorMatchesReference(t, g, y, w, res)
	assertCertificateValid(t, buildCertificate(t, g, y, w, res))
	if res.x[0].Cmp(y[0]) != 0 {
		t.Fatalf("isolated node moved from %s to %s", y[0].RatString(), res.x[0].RatString())
	}
}

func TestEqualAndNegativeObservations(t *testing.T) {
	ids := []string{"p", "q", "r", "s"}
	y := []*big.Rat{testRat("-11/2"), testRat("-3"), testRat("-3"), testRat("4/7")}
	w := []*big.Rat{testRat("1/3"), testRat("5"), testRat("5"), testRat("9/2")}
	edges := []Edge{
		{EdgeID: "a", From: "p", To: "q"},
		{EdgeID: "b", From: "q", To: "r"},
		{EdgeID: "c", From: "r", To: "s"},
	}
	g := mustCompile(t, ids, y, w, edges)
	res, err := g.Solve(y, w)
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	assertVectorMatchesReference(t, g, y, w, res)
	assertCertificateValid(t, buildCertificate(t, g, y, w, res))
}

func TestExtremeWeights(t *testing.T) {
	ids := []string{"lo", "hi"}
	y := []*big.Rat{testRat("100"), testRat("-100")}
	w := []*big.Rat{
		testRat("10000000000000000000000000000000000000000"),
		testRat("1/10000000000000000000000000000000000000000"),
	}
	edges := []Edge{{EdgeID: "ord", From: "lo", To: "hi"}}
	g := mustCompile(t, ids, y, w, edges)
	res, err := g.Solve(y, w)
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	assertVectorMatchesReference(t, g, y, w, res)
	assertCertificateValid(t, buildCertificate(t, g, y, w, res))
	if res.x[0].Cmp(res.x[1]) != 0 {
		t.Fatalf("chain must be pooled, got %s and %s", res.x[0].RatString(), res.x[1].RatString())
	}
}

func TestChainPooling(t *testing.T) {
	ids := []string{"n1", "n2", "n3"}
	y := []*big.Rat{testRat("3"), testRat("1"), testRat("2")}
	w := []*big.Rat{testRat("1"), testRat("1"), testRat("1")}
	edges := []Edge{
		{EdgeID: "c1", From: "n1", To: "n2"},
		{EdgeID: "c2", From: "n2", To: "n3"},
	}
	g := mustCompile(t, ids, y, w, edges)
	res, err := g.Solve(y, w)
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	assertVectorMatchesReference(t, g, y, w, res)
	assertCertificateValid(t, buildCertificate(t, g, y, w, res))
	want := testRat("2")
	for i := range ids {
		if res.x[i].Cmp(want) != 0 {
			t.Fatalf("chain pool expected 2 at node %d, got %s", i, res.x[i].RatString())
		}
	}
	if res.Blocks() != 1 {
		t.Fatalf("expected one pooled block, got %d", res.Blocks())
	}
}

// TestForkRequiresSplittingWrongPool uses a fork where the initial whole-graph
// pool is not optimal: the closure cut must split it.
func TestForkRequiresSplittingWrongPool(t *testing.T) {
	ids := []string{"a", "b", "c"}
	y := []*big.Rat{testRat("0"), testRat("10"), testRat("10")}
	w := []*big.Rat{testRat("100"), testRat("1"), testRat("1")}
	edges := []Edge{
		{EdgeID: "f1", From: "a", To: "b"},
		{EdgeID: "f2", From: "a", To: "c"},
	}
	g := mustCompile(t, ids, y, w, edges)
	res, err := g.Solve(y, w)
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	assertVectorMatchesReference(t, g, y, w, res)
	assertCertificateValid(t, buildCertificate(t, g, y, w, res))
	if res.Splits() == 0 {
		t.Fatalf("expected the wrong initial pool to be split")
	}
	if res.x[0].Cmp(res.x[1]) > 0 || res.x[0].Cmp(res.x[2]) > 0 {
		t.Fatalf("fork ordering violated: %v", res.x)
	}
}
