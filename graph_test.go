package dagcalc

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func mustAdd(t *testing.T, g *Graph, name string, e Expr) {
	t.Helper()
	if err := g.AddMetric(name, e); err != nil {
		t.Fatalf("AddMetric(%q): %v", name, err)
	}
}

func mustCommit(t *testing.T, g *Graph, updates map[string]int64) CommitRecord {
	t.Helper()
	rec, err := g.Commit(updates)
	if err != nil {
		t.Fatalf("Commit(%v): %v", updates, err)
	}
	return rec
}

func mustGet(t *testing.T, g *Graph, name string) int64 {
	t.Helper()
	v, ok := g.Get(name)
	if !ok {
		t.Fatalf("Get(%q): not found", name)
	}
	return v
}

// assertConsistent compares the incrementally maintained state against
// a from-scratch evaluation of the whole DAG.
func assertConsistent(t *testing.T, g *Graph) {
	t.Helper()
	full, err := g.FullEvaluate()
	if err != nil {
		t.Fatalf("FullEvaluate: %v", err)
	}
	version, snap := g.Snapshot()
	if version != g.Version() {
		t.Fatalf("snapshot version %d != Version() %d", version, g.Version())
	}
	if !reflect.DeepEqual(snap, full) {
		t.Fatalf("incremental %v != full evaluation %v", snap, full)
	}
}

func TestArithmeticAndVersions(t *testing.T) {
	g := New()
	mustAdd(t, g, "sum", Add(Ref("a"), Ref("b")))
	mustAdd(t, g, "prod", Mul(Ref("sum"), Const(3)))

	rec := mustCommit(t, g, map[string]int64{"a": 1, "b": 2})
	if rec.Version != 1 || g.Version() != 1 {
		t.Fatalf("first commit version = %d, want 1", rec.Version)
	}
	if !reflect.DeepEqual(rec.Recomputed, []string{"prod", "sum"}) {
		t.Fatalf("initial recompute = %v, want [prod sum]", rec.Recomputed)
	}
	if got := mustGet(t, g, "sum"); got != 3 {
		t.Fatalf("sum = %d, want 3", got)
	}
	if got := mustGet(t, g, "prod"); got != 9 {
		t.Fatalf("prod = %d, want 9", got)
	}

	rec = mustCommit(t, g, map[string]int64{"a": 2})
	if rec.Version != 2 {
		t.Fatalf("second commit version = %d, want 2", rec.Version)
	}
	if !reflect.DeepEqual(rec.ChangedInputs, []string{"a"}) {
		t.Fatalf("changed inputs = %v, want [a]", rec.ChangedInputs)
	}
	if got := mustGet(t, g, "prod"); got != 12 {
		t.Fatalf("prod = %d, want 12", got)
	}
	if info, _ := g.MetricInfo("prod"); info.Version != 2 {
		t.Fatalf("prod metric version = %d, want 2", info.Version)
	}
	assertConsistent(t, g)
}

func TestUnchangedValueCutsOffDependents(t *testing.T) {
	g := New()
	mustAdd(t, g, "sum", Add(Ref("a"), Ref("b")))
	mustAdd(t, g, "prod", Mul(Ref("sum"), Const(3)))
	mustCommit(t, g, map[string]int64{"a": 1, "b": 3})

	// a+b stays 4: sum is recomputed but keeps its value, so prod is skipped.
	rec := mustCommit(t, g, map[string]int64{"a": 2, "b": 2})
	if !reflect.DeepEqual(rec.Recomputed, []string{"sum"}) {
		t.Fatalf("recomputed = %v, want [sum]", rec.Recomputed)
	}
	if info, _ := g.MetricInfo("prod"); info.Version != 1 {
		t.Fatalf("prod version = %d, want 1 (untouched)", info.Version)
	}
	assertConsistent(t, g)
}

func TestNoOpCommitRecomputesNothing(t *testing.T) {
	g := New()
	mustAdd(t, g, "sum", Add(Ref("a"), Ref("b")))
	mustCommit(t, g, map[string]int64{"a": 1, "b": 2})

	rec := mustCommit(t, g, map[string]int64{"a": 1})
	if len(rec.ChangedInputs) != 0 || len(rec.Recomputed) != 0 {
		t.Fatalf("no-op commit = %+v, want no changes", rec)
	}
	if rec.Version != 2 {
		t.Fatalf("version = %d, want 2", rec.Version)
	}
	assertConsistent(t, g)
}

func TestConditionalActiveDependencies(t *testing.T) {
	g := New()
	mustAdd(t, g, "pick", If(Ref("flag"), Ref("x"), Ref("y")))
	rec := mustCommit(t, g, map[string]int64{"flag": 1, "x": 10, "y": 20})
	if got := mustGet(t, g, "pick"); got != 10 {
		t.Fatalf("pick = %d, want 10", got)
	}
	info, _ := g.MetricInfo("pick")
	if !reflect.DeepEqual(info.Deps, []string{"flag", "x"}) {
		t.Fatalf("active deps = %v, want [flag x]", info.Deps)
	}

	// y is only read by the untaken branch: changing it recomputes nothing.
	rec = mustCommit(t, g, map[string]int64{"y": 99})
	if len(rec.Recomputed) != 0 {
		t.Fatalf("recomputed = %v, want none", rec.Recomputed)
	}
	if got := mustGet(t, g, "pick"); got != 10 {
		t.Fatalf("pick = %d, want 10", got)
	}

	// Flipping the flag switches the active branch and picks up y.
	rec = mustCommit(t, g, map[string]int64{"flag": 0})
	if !reflect.DeepEqual(rec.Recomputed, []string{"pick"}) {
		t.Fatalf("recomputed = %v, want [pick]", rec.Recomputed)
	}
	if got := mustGet(t, g, "pick"); got != 99 {
		t.Fatalf("pick = %d, want 99", got)
	}
	info, _ = g.MetricInfo("pick")
	if !reflect.DeepEqual(info.Deps, []string{"flag", "y"}) {
		t.Fatalf("active deps = %v, want [flag y]", info.Deps)
	}
	assertConsistent(t, g)
}

func TestBatchPublishesAtomically(t *testing.T) {
	g := New()
	mustAdd(t, g, "total", Add(Ref("a"), Ref("b")))
	mustAdd(t, g, "spread", Sub(Ref("a"), Ref("b")))
	mustCommit(t, g, map[string]int64{"a": 5, "b": 1})

	// Two sources corrected in one batch: a single version, one record.
	rec := mustCommit(t, g, map[string]int64{"a": 8, "b": 3})
	if rec.Version != 2 || g.Version() != 2 {
		t.Fatalf("version = %d, want 2", rec.Version)
	}
	if !reflect.DeepEqual(rec.ChangedInputs, []string{"a", "b"}) {
		t.Fatalf("changed inputs = %v, want [a b]", rec.ChangedInputs)
	}
	version, snap := g.Snapshot()
	if version != 2 {
		t.Fatalf("snapshot version = %d, want 2", version)
	}
	if snap["total"] != 11 || snap["spread"] != 5 {
		t.Fatalf("snapshot = %v, want total=11 spread=5", snap)
	}
	if got := len(g.History()); got != 2 {
		t.Fatalf("history length = %d, want 2", got)
	}
	assertConsistent(t, g)
}

func TestComparisons(t *testing.T) {
	g := New()
	mustAdd(t, g, "gt", Gt(Ref("a"), Const(10)))
	mustAdd(t, g, "lt", Lt(Ref("a"), Const(10)))
	mustAdd(t, g, "eq", Eq(Ref("a"), Const(10)))
	mustCommit(t, g, map[string]int64{"a": 10})
	if got := mustGet(t, g, "gt"); got != 0 {
		t.Fatalf("gt = %d, want 0", got)
	}
	if got := mustGet(t, g, "lt"); got != 0 {
		t.Fatalf("lt = %d, want 0", got)
	}
	if got := mustGet(t, g, "eq"); got != 1 {
		t.Fatalf("eq = %d, want 1", got)
	}
	mustCommit(t, g, map[string]int64{"a": 42})
	if got := mustGet(t, g, "gt"); got != 1 {
		t.Fatalf("gt = %d, want 1", got)
	}
	assertConsistent(t, g)
}

func TestErrors(t *testing.T) {
	g := New()
	mustAdd(t, g, "m", Ref("a"))
	if err := g.AddMetric("m", Ref("b")); err == nil {
		t.Fatal("duplicate AddMetric: want error")
	}
	if _, err := g.Commit(map[string]int64{"m": 1}); err == nil {
		t.Fatal("commit updating a metric: want error")
	}

	cyclic := New()
	mustAdd(t, cyclic, "x", Ref("y"))
	mustAdd(t, cyclic, "y", Ref("x"))
	if _, err := cyclic.Commit(nil); err == nil {
		t.Fatal("cyclic graph: want error")
	}
}

// TestRandomizedAgainstFullEvaluation builds a random DAG and applies
// random batches of corrections, checking after every commit that the
// incremental state matches a full evaluation and that skipped metrics
// kept their values.
func TestRandomizedAgainstFullEvaluation(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	g := New()
	inputs := []string{"i0", "i1", "i2", "i3"}
	var metrics []string

	randOperand := func() Expr {
		choices := 3
		if len(metrics) == 0 {
			choices = 2
		}
		switch rng.Intn(choices) {
		case 0:
			return Const(int64(rng.Intn(7) - 3))
		case 1:
			return Ref(inputs[rng.Intn(len(inputs))])
		default:
			return Ref(metrics[rng.Intn(len(metrics))])
		}
	}
	for i := 0; i < 30; i++ {
		name := fmt.Sprintf("m%d", i)
		var e Expr
		switch rng.Intn(4) {
		case 0:
			e = Add(randOperand(), randOperand())
		case 1:
			e = Sub(randOperand(), randOperand())
		case 2:
			e = Mul(randOperand(), randOperand())
		default:
			e = If(randOperand(), randOperand(), randOperand())
		}
		mustAdd(t, g, name, e)
		metrics = append(metrics, name)
	}

	var prev map[string]int64
	for round := 0; round < 60; round++ {
		updates := make(map[string]int64)
		for _, in := range inputs {
			if rng.Intn(2) == 0 {
				updates[in] = int64(rng.Intn(11) - 5)
			}
		}
		rec := mustCommit(t, g, updates)
		if rec.Version != uint64(round+1) {
			t.Fatalf("round %d: version = %d", round, rec.Version)
		}
		recomputed := make(map[string]bool, len(rec.Recomputed))
		for _, name := range rec.Recomputed {
			recomputed[name] = true
			info, _ := g.MetricInfo(name)
			if info.Version != rec.Version {
				t.Fatalf("round %d: %s version = %d, want %d", round, name, info.Version, rec.Version)
			}
		}
		_, snap := g.Snapshot()
		if prev != nil {
			for name, v := range snap {
				if !recomputed[name] && v != prev[name] {
					t.Fatalf("round %d: skipped metric %s changed %d -> %d", round, name, prev[name], v)
				}
			}
		}
		prev = snap
		assertConsistent(t, g)
	}
}
