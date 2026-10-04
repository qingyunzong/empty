package permset

import (
	"errors"
	"slices"
	"testing"
)

func mustDefine(t *testing.T, r *Registry, name, expr string) *Version {
	t.Helper()
	v, err := r.Define(name, expr)
	if err != nil {
		t.Fatalf("Define(%q, %q): %v", name, expr, err)
	}
	return v
}

func mustEval(t *testing.T, r *Registry, name string) []Interval {
	t.Helper()
	got, err := r.Eval(name)
	if err != nil {
		t.Fatalf("Eval(%q): %v", name, err)
	}
	return got
}

func TestDefineAndEval(t *testing.T) {
	r := NewRegistry()
	mustDefine(t, r, "A", "[1,10]")
	mustDefine(t, r, "B", "A & [5,15]")
	if got := mustEval(t, r, "B"); !slices.Equal(got, []Interval{{5, 10}}) {
		t.Fatalf("got %v", got)
	}
}

func TestCorrectionPropagatesAndSnapshotsSurvive(t *testing.T) {
	r := NewRegistry()
	mustDefine(t, r, "A", "[1,10]")
	mustDefine(t, r, "B", "A | [20,30]")
	mustDefine(t, r, "C", "B - [25,35]")

	mustDefine(t, r, "A", "[1,5]") // correction
	if got := mustEval(t, r, "B"); !slices.Equal(got, []Interval{{1, 5}, {20, 30}}) {
		t.Fatalf("B got %v", got)
	}
	if got := mustEval(t, r, "C"); !slices.Equal(got, []Interval{{1, 5}, {20, 24}}) {
		t.Fatalf("C got %v", got)
	}

	// Old snapshots are preserved verbatim.
	snap, err := r.Snapshot("A", 1)
	if err != nil || !slices.Equal(snap, []Interval{{1, 10}}) {
		t.Fatalf("A v1 snapshot %v err %v", snap, err)
	}
	snap, err = r.Snapshot("B", 1)
	if err != nil || !slices.Equal(snap, []Interval{{1, 10}, {20, 30}}) {
		t.Fatalf("B v1 snapshot %v err %v", snap, err)
	}
	if vs := r.Versions("A"); len(vs) != 2 || vs[0].Expr != "[1,10]" || vs[1].Expr != "[1,5]" {
		t.Fatalf("versions %v", vs)
	}
	if bad := r.Verify(); len(bad) != 0 {
		t.Fatalf("Verify mismatches: %v", bad)
	}
}

func TestCorrectionPropagatesOnlyToDependencyClosure(t *testing.T) {
	r := NewRegistry()
	mustDefine(t, r, "A", "[1,10]")
	mustDefine(t, r, "B", "A & [5,15]")
	mustDefine(t, r, "C", "A | [100,200]")
	mustDefine(t, r, "D", "[7,9]") // independent of A
	mustEval(t, r, "D")

	r.EvalCount = 0
	mustDefine(t, r, "A", "[2,8]")
	if r.EvalCount != 3 {
		t.Fatalf("EvalCount = %d, want 3 (A, B, C only)", r.EvalCount)
	}
	if got := mustEval(t, r, "D"); !slices.Equal(got, []Interval{{7, 9}}) {
		t.Fatalf("D changed: %v", got)
	}
	if r.EvalCount != 3 {
		t.Fatalf("Eval(D) recomputed: EvalCount = %d", r.EvalCount)
	}
	if bad := r.Verify(); len(bad) != 0 {
		t.Fatalf("Verify mismatches: %v", bad)
	}
}

func TestCycleRejectedWithShortestChain(t *testing.T) {
	r := NewRegistry()
	mustDefine(t, r, "A", "[1,1]")
	mustDefine(t, r, "B", "A")
	mustDefine(t, r, "C", "B")

	_, err := r.Define("A", "C | [2,2]")
	var ce *CycleError
	if !errors.As(err, &ce) {
		t.Fatalf("got %v, want CycleError", err)
	}
	if want := []string{"A", "C", "B", "A"}; !slices.Equal(ce.Chain, want) {
		t.Fatalf("chain %v, want %v", ce.Chain, want)
	}
	// Registry unchanged after rejection.
	if got := mustEval(t, r, "A"); !slices.Equal(got, []Interval{{1, 1}}) {
		t.Fatalf("A mutated: %v", got)
	}
}

func TestSelfCycle(t *testing.T) {
	r := NewRegistry()
	mustDefine(t, r, "X", "[0,0]")
	_, err := r.Define("X", "X | [1,1]")
	var ce *CycleError
	if !errors.As(err, &ce) || !slices.Equal(ce.Chain, []string{"X", "X"}) {
		t.Fatalf("got %v", err)
	}
}

func TestShortestChainAmongMultipleCycles(t *testing.T) {
	r := NewRegistry()
	mustDefine(t, r, "A", "[1,1]")
	mustDefine(t, r, "B", "A")
	mustDefine(t, r, "C", "B")
	mustDefine(t, r, "D", "C")
	// Redefining A with refs to B and D closes two cycles:
	// A->B->A (length 3) and A->D->C->B->A (length 5). Shortest wins.
	_, err := r.Define("A", "B | D")
	var ce *CycleError
	if !errors.As(err, &ce) {
		t.Fatalf("got %v, want CycleError", err)
	}
	if want := []string{"A", "B", "A"}; !slices.Equal(ce.Chain, want) {
		t.Fatalf("chain %v, want %v", ce.Chain, want)
	}
}

func TestProvenanceWitnesses(t *testing.T) {
	r := NewRegistry()
	mustDefine(t, r, "A", "[1,5]")
	mustDefine(t, r, "B", "[5,10]")

	segs, err := r.EvalExprSegments("A | B")
	if err != nil {
		t.Fatal(err)
	}
	want := []Segment{
		{Interval{1, 4}, []string{"A", "[1,5]"}},
		{Interval{5, 5}, []string{"A", "B", "[1,5]", "[5,10]"}},
		{Interval{6, 10}, []string{"B", "[5,10]"}},
	}
	if !slices.EqualFunc(segs, want, func(a, b Segment) bool {
		return a.Interval == b.Interval && slices.Equal(a.Sources, b.Sources)
	}) {
		t.Fatalf("got %v", segs)
	}

	// Difference keeps the left side's witnesses; intersection unions both.
	segs, err = r.EvalExprSegments("A - [3,3]")
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range segs {
		if !slices.Equal(s.Sources, []string{"A", "[1,5]"}) {
			t.Fatalf("diff segment %v has sources %v", s.Interval, s.Sources)
		}
	}
	segs, err = r.EvalExprSegments("A & B")
	if err != nil {
		t.Fatal(err)
	}
	if len(segs) != 1 || segs[0].Interval != (Interval{5, 5}) ||
		!slices.Equal(segs[0].Sources, []string{"A", "B", "[1,5]", "[5,10]"}) {
		t.Fatalf("intersect got %v", segs)
	}
}

func TestVerifyDetectsCorruption(t *testing.T) {
	r := NewRegistry()
	mustDefine(t, r, "A", "[1,10]")
	mustDefine(t, r, "B", "A | [20,30]")
	if bad := r.Verify(); len(bad) != 0 {
		t.Fatalf("unexpected mismatches: %v", bad)
	}
	// Tamper with the incremental cache; full recomputation must catch it.
	r.current["B"] = []Segment{{Interval: Interval{1, 1}}}
	if bad := r.Verify(); !slices.Equal(bad, []string{"B"}) {
		t.Fatalf("Verify got %v, want [B]", bad)
	}
}

func TestVersionNumbersAndDeps(t *testing.T) {
	r := NewRegistry()
	v1 := mustDefine(t, r, "A", "[1,2]")
	v2 := mustDefine(t, r, "A", "[1,3]")
	if v1.Num != 1 || v2.Num != 2 {
		t.Fatalf("nums %d %d", v1.Num, v2.Num)
	}
	v := mustDefine(t, r, "B", "A | [9,9]")
	if !slices.Equal(v.Deps, []string{"A"}) {
		t.Fatalf("deps %v", v.Deps)
	}
	if _, err := r.Snapshot("A", 3); err == nil {
		t.Fatal("expected error for missing version")
	}
}
