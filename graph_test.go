package dagmetrics

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// fixture builds:
//
//	a, b, c        sources
//	sum   = a + b
//	diff  = sum - c
//	prod  = diff * c
//	pick  = cond(a, sum, prod)   // a != 0 ? sum : prod
func fixture(t *testing.T) *Graph {
	t.Helper()
	g, err := NewGraph(
		[]string{"a", "b", "c"},
		map[string]*Expr{
			"sum":  Add(Ref("a"), Ref("b")),
			"diff": Sub(Ref("sum"), Ref("c")),
			"prod": Mul(Ref("diff"), Ref("c")),
			"pick": Cond(Ref("a"), Ref("sum"), Ref("prod")),
		},
	)
	if err != nil {
		t.Fatalf("NewGraph: %v", err)
	}
	return g
}

func mustSnapshot(t *testing.T, g *Graph) map[string]int64 {
	t.Helper()
	full, err := g.EvaluateAll()
	if err != nil {
		t.Fatalf("EvaluateAll: %v", err)
	}
	inc := g.Snapshot()
	if !reflect.DeepEqual(inc, full) {
		t.Fatalf("incremental %v != full %v", inc, full)
	}
	return inc
}

func TestBatchAtomicPublishAndValues(t *testing.T) {
	g := fixture(t)

	// Multiple sources corrected in one batch => exactly one version bump.
	b, err := g.Update(map[string]int64{"a": 3, "b": 4, "c": 2})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if b.Version != 1 || g.Version() != 1 {
		t.Fatalf("version = %d, want 1", b.Version)
	}
	want := map[string]int64{
		"a": 3, "b": 4, "c": 2,
		"sum": 7, "diff": 5, "prod": 10, "pick": 7,
	}
	if got := mustSnapshot(t, g); !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot = %v, want %v", got, want)
	}
	wantRecomputed := []string{"sum", "diff", "prod", "pick"}
	if !reflect.DeepEqual(b.Recomputed, wantRecomputed) {
		t.Fatalf("recomputed = %v, want %v", b.Recomputed, wantRecomputed)
	}
	if !reflect.DeepEqual(b.Changed, []string{"a", "b", "c", "diff", "pick", "prod", "sum"}) {
		t.Fatalf("changed = %v", b.Changed)
	}

	// Every node must record the version at which it last changed.
	for name := range want {
		_, v, err := g.Value(name)
		if err != nil {
			t.Fatalf("Value(%q): %v", name, err)
		}
		if v != 1 {
			t.Fatalf("Value(%q) version = %d, want 1", name, v)
		}
	}
}

func TestIncrementalClosureEarlyCutoff(t *testing.T) {
	g := fixture(t)
	if _, err := g.Update(map[string]int64{"a": 1, "b": 1, "c": 2}); err != nil {
		t.Fatal(err)
	}
	// sum=2, diff=0, prod=0, pick=2

	// Correct b so that sum changes but diff stays 0: prod and pick must not
	// be recomputed (early cutoff), and their versions stay at 1.
	b, err := g.Update(map[string]int64{"b": 3})
	if err != nil {
		t.Fatal(err)
	}
	// sum=4, diff=2 -> prod changes. Use a correction that keeps diff at 0:
	// b: 1 -> 1 is a no-op; instead set a so sum-c stays 0: a=1,b=1,c=2 => sum=2.
	// Redo: set b back so sum = c.
	_ = b
	if _, err := g.Update(map[string]int64{"b": 1}); err != nil {
		t.Fatal(err)
	}
	// Now sum=2, diff=0, prod=0, pick=2. Correct a only: a=1->0 flips cond,
	// so pick must recompute; sum changes too.
	b, err = g.Update(map[string]int64{"a": 0})
	if err != nil {
		t.Fatal(err)
	}
	// sum=1, diff=-1, prod=-2, pick = cond(0,1,-2) = -2
	want := map[string]int64{"a": 0, "b": 1, "c": 2, "sum": 1, "diff": -1, "prod": -2, "pick": -2}
	if got := mustSnapshot(t, g); !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot = %v, want %v", got, want)
	}

	// Cutoff check: c=2, set a=0,b=2 => sum=2, diff=0, prod=0. Then b: 2->0
	// keeps sum=2 (a=0): diff/prod/pick unchanged, only sum recomputed but
	// unchanged in value... verify a case where a recomputed node's value is
	// unchanged and its dependents are skipped.
	g2 := fixture(t)
	if _, err := g2.Update(map[string]int64{"a": 5, "b": 5, "c": 10}); err != nil {
		t.Fatal(err)
	}
	// sum=10, diff=0, prod=0, pick=10
	b2, err := g2.Update(map[string]int64{"a": 7, "b": 3}) // sum stays 10
	if err != nil {
		t.Fatal(err)
	}
	// sum recomputed (deps changed) but value unchanged => diff, prod skipped.
	// pick depends on a directly, so it is recomputed too, but cond(7,10,0)=10
	// keeps its value unchanged, so it does not propagate either.
	if !reflect.DeepEqual(b2.Recomputed, []string{"sum", "pick"}) {
		t.Fatalf("recomputed = %v, want [sum pick]", b2.Recomputed)
	}
	if !reflect.DeepEqual(b2.Changed, []string{"a", "b"}) {
		t.Fatalf("changed = %v, want [a b]", b2.Changed)
	}
	if _, v, _ := g2.Value("prod"); v != 0 {
		t.Fatalf("prod version = %d, want 0 (value never changed)", v)
	}
	if _, v, _ := g2.Value("sum"); v != 1 {
		t.Fatalf("sum version = %d, want 1 (value unchanged)", v)
	}
}

func TestNoOpCorrectionStillBumpsVersion(t *testing.T) {
	g := fixture(t)
	if _, err := g.Update(map[string]int64{"a": 1}); err != nil {
		t.Fatal(err)
	}
	b, err := g.Update(map[string]int64{"a": 1}) // same value
	if err != nil {
		t.Fatal(err)
	}
	if b.Version != 2 {
		t.Fatalf("version = %d, want 2", b.Version)
	}
	if len(b.Recomputed) != 0 || len(b.Changed) != 0 {
		t.Fatalf("no-op batch recomputed %v changed %v", b.Recomputed, b.Changed)
	}
	mustSnapshot(t, g)
}

func TestBatchHistoryRecorded(t *testing.T) {
	g := fixture(t)
	if _, err := g.Update(map[string]int64{"a": 1, "c": 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := g.Update(map[string]int64{"b": 2}); err != nil {
		t.Fatal(err)
	}
	batches := g.Batches()
	if len(batches) != 2 || batches[0].Version != 1 || batches[1].Version != 2 {
		t.Fatalf("batches = %+v", batches)
	}
}

func TestErrors(t *testing.T) {
	if _, err := NewGraph(nil, map[string]*Expr{"x": Ref("y"), "y": Ref("x")}); err == nil {
		t.Fatal("expected cycle error")
	}
	if _, err := NewGraph(nil, map[string]*Expr{"x": Ref("nope")}); err == nil {
		t.Fatal("expected unknown reference error")
	}
	if _, err := NewGraph([]string{"a"}, map[string]*Expr{"a": Const(1)}); err == nil {
		t.Fatal("expected duplicate error")
	}
	g := fixture(t)
	if _, err := g.Update(map[string]int64{"sum": 1}); err == nil {
		t.Fatal("expected derived-update error")
	}
	if _, err := g.Update(map[string]int64{"ghost": 1}); err == nil {
		t.Fatal("expected unknown-source error")
	}
	if _, _, err := g.Value("ghost"); err == nil {
		t.Fatal("expected unknown metric error")
	}
}

// TestFuzzAgainstFullEvaluation builds random DAGs, applies random batches,
// and after every batch checks the incremental snapshot against a full
// evaluation, plus the recomputed set against an independently computed
// dirty-closure.
func TestFuzzAgainstFullEvaluation(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 200; trial++ {
		nSrc := 1 + rng.Intn(4)
		nDer := 1 + rng.Intn(8)
		sources := make([]string, nSrc)
		for i := range sources {
			sources[i] = fmt.Sprintf("s%d", i)
		}
		derived := make(map[string]*Expr)
		avail := append([]string(nil), sources...)
		for i := 0; i < nDer; i++ {
			name := fmt.Sprintf("d%d", i)
			derived[name] = randomExpr(rng, avail, 2)
			avail = append(avail, name)
		}
		g, err := NewGraph(sources, derived)
		if err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		for batch := 0; batch < 20; batch++ {
			corr := map[string]int64{}
			for _, s := range sources {
				if rng.Intn(2) == 0 {
					corr[s] = int64(rng.Intn(7) - 3)
				}
			}
			if len(corr) == 0 {
				corr[sources[rng.Intn(nSrc)]] = int64(rng.Intn(7) - 3)
			}
			before := g.Snapshot()
			got, err := g.Update(corr)
			if err != nil {
				t.Fatalf("trial %d batch %d: %v", trial, batch, err)
			}
			full, err := g.EvaluateAll()
			if err != nil {
				t.Fatalf("trial %d batch %d: %v", trial, batch, err)
			}
			if inc := g.Snapshot(); !reflect.DeepEqual(inc, full) {
				t.Fatalf("trial %d batch %d: incremental %v != full %v", trial, batch, inc, full)
			}
			wantRec, wantChg := expectedClosure(g, before, corr, full)
			if !reflect.DeepEqual(got.Recomputed, wantRec) {
				t.Fatalf("trial %d batch %d: recomputed %v != closure %v", trial, batch, got.Recomputed, wantRec)
			}
			if !reflect.DeepEqual(got.Changed, wantChg) {
				t.Fatalf("trial %d batch %d: changed %v != %v", trial, batch, got.Changed, wantChg)
			}
		}
	}
}

func randomExpr(rng *rand.Rand, avail []string, depth int) *Expr {
	leaf := func() *Expr {
		if rng.Intn(2) == 0 {
			return Const(int64(rng.Intn(7) - 3))
		}
		return Ref(avail[rng.Intn(len(avail))])
	}
	if depth == 0 {
		return leaf()
	}
	switch rng.Intn(4) {
	case 0:
		return Add(randomExpr(rng, avail, depth-1), randomExpr(rng, avail, depth-1))
	case 1:
		return Sub(randomExpr(rng, avail, depth-1), randomExpr(rng, avail, depth-1))
	case 2:
		return Mul(randomExpr(rng, avail, depth-1), randomExpr(rng, avail, depth-1))
	default:
		return Cond(randomExpr(rng, avail, depth-1), randomExpr(rng, avail, depth-1), randomExpr(rng, avail, depth-1))
	}
}

// expectedClosure independently replays the batch semantics: sources whose
// value changed mark derived dependents dirty in topological order; a dirty
// node is recomputed and only propagates if its value actually changed.
func expectedClosure(g *Graph, before, corr, after map[string]int64) (recomputed, changed []string) {
	chg := map[string]bool{}
	for s, v := range corr {
		if before[s] != v {
			chg[s] = true
		}
	}
	for _, name := range g.order {
		n := g.nodes[name]
		if n.source {
			continue
		}
		dirty := false
		for _, d := range n.deps {
			if chg[d] {
				dirty = true
				break
			}
		}
		if !dirty {
			continue
		}
		recomputed = append(recomputed, name)
		if before[name] != after[name] {
			chg[name] = true
		}
	}
	for c := range chg {
		changed = append(changed, c)
	}
	sort.Strings(changed)
	return recomputed, changed
}
