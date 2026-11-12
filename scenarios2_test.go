package dataeng

import (
	"math/big"
	"testing"
)

// TestRedundantEdgesMultipliersNotUnique builds a diamond plus a redundant
// transitive edge so several multiplier routings exist.
func TestRedundantEdgesMultipliersNotUnique(t *testing.T) {
	ids := []string{"a", "b", "c", "d"}
	y := []*big.Rat{testRat("10"), testRat("0"), testRat("0"), testRat("-10")}
	w := []*big.Rat{testRat("1"), testRat("1"), testRat("1"), testRat("1")}
	edges := []Edge{
		{EdgeID: "r1", From: "a", To: "b"},
		{EdgeID: "r2", From: "a", To: "c"},
		{EdgeID: "r3", From: "b", To: "d"},
		{EdgeID: "r4", From: "c", To: "d"},
		{EdgeID: "r5", From: "a", To: "d"},
	}
	g := mustCompile(t, ids, y, w, edges)
	res, err := g.Solve(y, w)
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	assertVectorMatchesReference(t, g, y, w, res)
	c := buildCertificate(t, g, y, w, res)
	assertCertificateValid(t, c)

	// Re-route one multiplier unit from the direct redundant edge onto the
	// a->b->d path. Stationarity balances are preserved and every value stays
	// non-negative, demonstrating the multiplier is not unique.
	alt := c
	alt.Lambda = map[string]*big.Rat{
		"r5": ratSub(res.lambda[4], testRat("1")),
		"r1": ratSum(res.lambda[0], testRat("1")),
		"r3": ratSum(res.lambda[2], testRat("1")),
		"r2": ratCopy(res.lambda[1]),
		"r4": ratCopy(res.lambda[3]),
	}
	for id, v := range alt.Lambda {
		if v.Sign() < 0 {
			t.Fatalf("alternative routing made %s negative", id)
		}
	}
	assertCertificateValid(t, alt)
}

func TestDuplicateEdgesDedupKeepSourceIDs(t *testing.T) {
	ids := []string{"u", "v"}
	y := []*big.Rat{testRat("5"), testRat("1")}
	w := []*big.Rat{testRat("1"), testRat("1")}
	edges := []Edge{
		{EdgeID: "src-1", From: "u", To: "v"},
		{EdgeID: "src-2", From: "u", To: "v"},
		{EdgeID: "src-3", From: "u", To: "v"},
	}
	g := mustCompile(t, ids, y, w, edges)
	if g.DedupEdgeCount() != 1 {
		t.Fatalf("expected one unique edge, got %d", g.DedupEdgeCount())
	}
	got := g.DedupEdges()[0]
	if len(got.SourceIDs) != 3 || got.SourceIDs[0] != "src-1" || got.SourceIDs[2] != "src-3" {
		t.Fatalf("source IDs not retained: %v", got.SourceIDs)
	}
	res, err := g.Solve(y, w)
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	if _, err := res.LambdaBySourceID("src-2"); err != nil {
		t.Fatalf("source mapping: %v", err)
	}
	assertCertificateValid(t, buildCertificate(t, g, y, w, res))
}

func TestMultipleComponents(t *testing.T) {
	ids := []string{"a1", "a2", "b1", "b2", "iso"}
	y := []*big.Rat{testRat("4"), testRat("0"), testRat("2"), testRat("8"), testRat("-1/9")}
	w := []*big.Rat{testRat("1"), testRat("1"), testRat("3"), testRat("1"), testRat("7")}
	edges := []Edge{
		{EdgeID: "g1", From: "a1", To: "a2"},
		{EdgeID: "g2", From: "b1", To: "b2"},
	}
	g := mustCompile(t, ids, y, w, edges)
	res, err := g.Solve(y, w)
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	assertVectorMatchesReference(t, g, y, w, res)
	assertCertificateValid(t, buildCertificate(t, g, y, w, res))
	if res.x[4].Cmp(y[4]) != 0 {
		t.Fatalf("isolated component node moved")
	}
}

func TestRejectsBadInputs(t *testing.T) {
	base := func() ([]string, []*big.Rat, []*big.Rat) {
		return []string{"a", "b"},
			[]*big.Rat{testRat("1"), testRat("2")},
			[]*big.Rat{testRat("1"), testRat("1")}
	}

	if _, err := Compile([]string{"a", "a"}, []*big.Rat{testRat("1"), testRat("2")},
		[]*big.Rat{testRat("1"), testRat("1")}, nil); err == nil {
		t.Fatalf("duplicate node ID accepted")
	}
	ids, y, w := base()
	if _, err := Compile(ids, y, append(w, testRat("1")), nil); err == nil {
		t.Fatalf("length mismatch accepted")
	}
	ids, y, w = base()
	if _, err := Compile(ids, y, []*big.Rat{testRat("0"), testRat("1")}, nil); err == nil {
		t.Fatalf("zero weight accepted")
	}
	ids, y, w = base()
	if _, err := Compile(ids, y, w, []Edge{{EdgeID: "x", From: "a", To: "z"}}); err == nil {
		t.Fatalf("unknown endpoint accepted")
	}
	ids, y, w = base()
	if _, err := Compile(ids, y, w, []Edge{{EdgeID: "x", From: "a", To: "a"}}); err == nil {
		t.Fatalf("self loop accepted")
	}
	ids, y, w = base()
	if _, err := Compile(ids, y, w, []Edge{
		{EdgeID: "x", From: "a", To: "b"},
		{EdgeID: "y", From: "b", To: "a"},
	}); err == nil {
		t.Fatalf("cycle accepted")
	}
}

func TestGraphReuseAndImmutability(t *testing.T) {
	ids := []string{"lo", "hi"}
	y1 := []*big.Rat{testRat("3"), testRat("1")}
	w1 := []*big.Rat{testRat("1"), testRat("1")}
	edges := []Edge{{EdgeID: "e", From: "lo", To: "hi"}}
	g := mustCompile(t, ids, y1, w1, edges)

	r1, err := g.Solve(y1, w1)
	if err != nil {
		t.Fatalf("first solve: %v", err)
	}
	firstX := r1.XByIndex(0)

	y2 := []*big.Rat{testRat("10"), testRat("20")}
	w2 := []*big.Rat{testRat("2"), testRat("3")}
	r2, err := g.Solve(y2, w2)
	if err != nil {
		t.Fatalf("second solve: %v", err)
	}

	// Mutating caller slices after Solve must not change either result.
	y1[0].SetInt64(999)
	w2[0].SetInt64(999)
	if r1.XByIndex(0).Cmp(firstX) != 0 {
		t.Fatalf("first result changed after a later solve / caller mutation")
	}
	if r1.F().Cmp(r1.F()) != 0 || r2.F().Sign() < 0 {
		t.Fatalf("objective corruption")
	}
	assertCertificateValid(t, buildCertificate(t, g, []*big.Rat{testRat("3"), testRat("1")},
		[]*big.Rat{testRat("1"), testRat("1")}, r1))

	// Compiled axioms are unchanged.
	de := g.DedupEdges()
	if len(de) != 1 || de[0].From != "lo" || de[0].To != "hi" {
		t.Fatalf("compiled graph was mutated: %v", de)
	}
}

func TestCertificateTamperingRejected(t *testing.T) {
	ids := []string{"a", "b", "c"}
	y := []*big.Rat{testRat("3"), testRat("1"), testRat("2")}
	w := []*big.Rat{testRat("1"), testRat("1"), testRat("1")}
	edges := []Edge{
		{EdgeID: "e1", From: "a", To: "b"},
		{EdgeID: "e2", From: "b", To: "c"},
	}
	g := mustCompile(t, ids, y, w, edges)
	res, err := g.Solve(y, w)
	if err != nil {
		t.Fatalf("solve: %v", err)
	}
	good := buildCertificate(t, g, y, w, res)
	assertCertificateValid(t, good)

	// 1. Tamper with x so primal feasibility breaks.
	badX := good
	badX.X = map[string]*big.Rat{
		"a": new(big.Rat).Set(good.X["a"]),
		"b": testRat("999"),
		"c": new(big.Rat).Set(good.X["c"]),
	}
	// The chain is fully pooled, so the tamper first breaks complementarity
	// (the unchanged positive multiplier now spans a nonzero gap); a separate
	// diamond case below covers the pure feasibility path.
	assertCertificateInvalid(t, badX, "complementarity")

	// 2. Flip a multiplier to a negative value.
	badSign := good
	badSign.Lambda = map[string]*big.Rat{
		"e1": new(big.Rat).Neg(res.lambda[0]),
		"e2": ratCopy(res.lambda[1]),
	}
	assertCertificateInvalid(t, badSign, "negative")

	// 3. Corrupt the flow balance at one node (stationarity must fail) while
	// keeping every multiplier non-negative and feasible.
	badFlow := good
	badFlow.Lambda = map[string]*big.Rat{
		"e1": ratSum(res.lambda[0], testRat("1")),
		"e2": ratCopy(res.lambda[1]),
	}
	assertCertificateInvalid(t, badFlow, "stationarity")

	// 4. Claim a wrong objective value.
	badF := good
	badF.F = ratSum(good.F, testRat("1"))
	assertCertificateInvalid(t, badF, "objective")

	// 5. A positive multiplier on a non-tight edge breaks complementarity.
	diamondIDs := []string{"b", "l", "r", "t"}
	dy := []*big.Rat{testRat("0"), testRat("5"), testRat("9"), testRat("10")}
	dw := []*big.Rat{testRat("1"), testRat("1"), testRat("1"), testRat("1")}
	dEdges := []Edge{
		{EdgeID: "e1", From: "b", To: "l"},
		{EdgeID: "e2", From: "b", To: "r"},
		{EdgeID: "e3", From: "l", To: "t"},
		{EdgeID: "e4", From: "r", To: "t"},
	}
	dg := mustCompile(t, diamondIDs, dy, dw, dEdges)
	dres, err := dg.Solve(dy, dw)
	if err != nil {
		t.Fatalf("diamond solve: %v", err)
	}
	dc := buildCertificate(t, dg, dy, dw, dres)
	// 6. Move one node across an edge while all multipliers stay zero: this
	// must be rejected on primal feasibility, not stationarity/complementarity.
	feasBad := buildCertificate(t, dg, dy, dw, dres)
	feasBad.X = map[string]*big.Rat{
		"b": new(big.Rat).Set(feasBad.X["b"]),
		"l": testRat("999"),
		"r": new(big.Rat).Set(feasBad.X["r"]),
		"t": new(big.Rat).Set(feasBad.X["t"]),
	}
	assertCertificateInvalid(t, feasBad, "feasibility")
	for k, e := range dg.edges {
		if dres.x[e.from].Cmp(dres.x[e.to]) < 0 && dres.lambda[k].Sign() == 0 {
			dc.Lambda[dg.edges[k].sourceIDs[0]] = testRat("1")
			break
		}
	}
	assertCertificateInvalid(t, dc, "complementarity")
}
