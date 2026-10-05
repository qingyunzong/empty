package permset

import (
	"errors"
	"slices"
	"testing"
)

func mustDefine(t *testing.T, e *Env, name, expr string) []string {
	t.Helper()
	affected, err := e.Define(name, expr)
	if err != nil {
		t.Fatalf("Define(%q, %q): %v", name, expr, err)
	}
	return affected
}

func TestDefineAndGet(t *testing.T) {
	e := NewEnv()
	affected := mustDefine(t, e, "A", "[1,5] | [10,12]")
	if len(affected) != 0 {
		t.Fatalf("affected = %v, want none", affected)
	}
	d, ok := e.Get("A")
	if !ok {
		t.Fatal("A not found")
	}
	if d.Version != 1 || d.Expr != "[1,5] | [10,12]" {
		t.Fatalf("unexpected def: %+v", d)
	}
	want := Set{ivs: []Interval{{1, 5}, {10, 12}}}
	if !d.Value.Equal(want) {
		t.Fatalf("value = %v, want %v", d.Value, want)
	}
	if !slices.Equal(d.Refs, []string(nil)) {
		t.Fatalf("refs = %v, want none", d.Refs)
	}
}

func TestDefineUndefinedRef(t *testing.T) {
	e := NewEnv()
	_, err := e.Define("B", "A | [1,2]")
	var uerr *UndefinedError
	if !errors.As(err, &uerr) || uerr.Name != "A" {
		t.Fatalf("got %v, want UndefinedError for A", err)
	}
}

func TestDefineInvalidName(t *testing.T) {
	e := NewEnv()
	for _, name := range []string{"", "min", "max", "1x", "a b"} {
		if _, err := e.Define(name, "[1,2]"); err == nil {
			t.Fatalf("Define(%q): expected error", name)
		}
	}
}

func TestSelfCycleRejected(t *testing.T) {
	e := NewEnv()
	mustDefine(t, e, "D", "[1,1]")
	_, err := e.Define("D", "D | [2,2]")
	var cerr *CycleError
	if !errors.As(err, &cerr) {
		t.Fatalf("got %v, want CycleError", err)
	}
	if !slices.Equal(cerr.Chain, []string{"D", "D"}) {
		t.Fatalf("chain = %v, want [D D]", cerr.Chain)
	}
	// Rejection leaves the old definition untouched.
	d, _ := e.Get("D")
	if d.Version != 1 || !d.Value.Equal(Set{ivs: []Interval{{1, 1}}}) {
		t.Fatalf("D changed after rejection: %+v", d)
	}
}

func TestIndirectCycleRejected(t *testing.T) {
	e := NewEnv()
	mustDefine(t, e, "A", "[1,2]")
	mustDefine(t, e, "B", "A | [3,4]")
	_, err := e.Define("A", "B & [1,9]")
	var cerr *CycleError
	if !errors.As(err, &cerr) {
		t.Fatalf("got %v, want CycleError", err)
	}
	if !slices.Equal(cerr.Chain, []string{"A", "B", "A"}) {
		t.Fatalf("chain = %v, want [A B A]", cerr.Chain)
	}
}

func TestShortestCycleChainReturned(t *testing.T) {
	e := NewEnv()
	mustDefine(t, e, "X", "[0,0]")
	mustDefine(t, e, "P", "X")
	mustDefine(t, e, "Q", "X")
	mustDefine(t, e, "R", "P")
	// Tentative edges X -> {Q, R} close two cycles:
	// X -> Q -> X (length 2) and X -> R -> P -> X (length 3).
	_, err := e.Define("X", "R | Q")
	var cerr *CycleError
	if !errors.As(err, &cerr) {
		t.Fatalf("got %v, want CycleError", err)
	}
	if !slices.Equal(cerr.Chain, []string{"X", "Q", "X"}) {
		t.Fatalf("chain = %v, want shortest [X Q X]", cerr.Chain)
	}
}

func TestCorrectionPropagatesToDependentClosureOnly(t *testing.T) {
	e := NewEnv()
	mustDefine(t, e, "A", "[1,5]")
	mustDefine(t, e, "B", "A | [10,20]")
	mustDefine(t, e, "C", "[100,200]") // independent of A
	mustDefine(t, e, "D", "B & [15,25]")

	affected := mustDefine(t, e, "A", "[2,6]")
	if !slices.Equal(affected, []string{"B", "D"}) {
		t.Fatalf("affected = %v, want [B D]", affected)
	}

	b, _ := e.Get("B")
	if b.Version != 2 {
		t.Fatalf("B version = %d, want 2", b.Version)
	}
	if want := (Set{ivs: []Interval{{2, 6}, {10, 20}}}); !b.Value.Equal(want) {
		t.Fatalf("B = %v, want %v", b.Value, want)
	}
	d, _ := e.Get("D")
	if d.Version != 2 {
		t.Fatalf("D version = %d, want 2", d.Version)
	}
	if want := (Set{ivs: []Interval{{15, 20}}}); !d.Value.Equal(want) {
		t.Fatalf("D = %v, want %v", d.Value, want)
	}
	// C is outside the dependency closure: untouched, not recomputed.
	c, _ := e.Get("C")
	if c.Version != 1 {
		t.Fatalf("C version = %d, want 1 (must not be recomputed)", c.Version)
	}
	if len(e.Versions("C")) != 1 {
		t.Fatalf("C history = %d versions, want 1", len(e.Versions("C")))
	}
}

func TestOldSnapshotsPreserved(t *testing.T) {
	e := NewEnv()
	mustDefine(t, e, "A", "[1,5]")
	mustDefine(t, e, "B", "A | [10,20]")
	mustDefine(t, e, "A", "[2,6]")

	a1, ok := e.Snapshot("A", 1)
	if !ok || !a1.Value.Equal(Set{ivs: []Interval{{1, 5}}}) {
		t.Fatalf("A@v1 = %v, want {[1,5]}", a1.Value)
	}
	b1, ok := e.Snapshot("B", 1)
	if !ok || !b1.Value.Equal(Set{ivs: []Interval{{1, 5}, {10, 20}}}) {
		t.Fatalf("B@v1 = %v, want {[1,5],[10,20]}", b1.Value)
	}
	a2, ok := e.Snapshot("A", 2)
	if !ok || !a2.Value.Equal(Set{ivs: []Interval{{2, 6}}}) {
		t.Fatalf("A@v2 = %v, want {[2,6]}", a2.Value)
	}
	if _, ok := e.Snapshot("A", 3); ok {
		t.Fatal("A@v3 should not exist")
	}
}

func TestVerifyFullRecomputation(t *testing.T) {
	e := NewEnv()
	mustDefine(t, e, "A", "[1,5]")
	mustDefine(t, e, "B", "A | [10,20]")
	mustDefine(t, e, "C", "[100,200]")
	mustDefine(t, e, "D", "B & [15,25] | C")
	mustDefine(t, e, "A", "[2,6]")
	mustDefine(t, e, "C", "[100,150] | [180,200]")
	mustDefine(t, e, "B", "A - [4,5]")
	if err := e.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestEvalInEnv(t *testing.T) {
	e := NewEnv()
	mustDefine(t, e, "A", "[1,5]")
	w, err := e.Eval("A & [3,9]")
	if err != nil {
		t.Fatal(err)
	}
	if want := (Set{ivs: []Interval{{3, 5}}}); !w.Set().Equal(want) {
		t.Fatalf("got %v, want %v", w.Set(), want)
	}
	if _, err := e.Eval("nope | [1,2]"); err == nil {
		t.Fatal("expected UndefinedError")
	}
	if _, err := e.Eval("[1,"); err == nil {
		t.Fatal("expected syntax error")
	}
}
