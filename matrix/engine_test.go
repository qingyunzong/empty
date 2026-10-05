package matrix

import (
	"errors"
	"math"
	"math/rand"
	"path/filepath"
	"testing"
)

func TestIncrementalMatchesNaive(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	for trial := 0; trial < 50; trial++ {
		m, k, n := 1+r.Intn(5), 1+r.Intn(5), 1+r.Intn(5)
		e := NewEngine(m, k, n)
		steps := 1 + r.Intn(40)
		for s := 0; s < steps; s++ {
			v := r.Int63n(21) - 10 // includes zeros -> deletions
			if r.Intn(2) == 0 {
				if err := e.SetA(r.Intn(m), r.Intn(k), v); err != nil {
					t.Fatalf("trial %d step %d: SetA: %v", trial, s, err)
				}
			} else {
				if err := e.SetB(r.Intn(k), r.Intn(n), v); err != nil {
					t.Fatalf("trial %d step %d: SetB: %v", trial, s, err)
				}
			}
		}
		if err := e.Verify(1_000_000); err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
	}
}

func TestZeroCorrectionsDeleteFromC(t *testing.T) {
	e := NewEngine(2, 2, 2)
	_ = e.SetA(0, 0, 3)
	_ = e.SetB(0, 1, 4)
	if got := e.C.Get(0, 1); got != 12 {
		t.Fatalf("C[0][1] = %d, want 12", got)
	}
	// Zero out A[0][0]; C[0][1] must be removed, not stored as zero.
	if err := e.SetA(0, 0, 0); err != nil {
		t.Fatal(err)
	}
	if e.C.NNZ() != 0 {
		t.Fatalf("C should be empty, NNZ=%d", e.C.NNZ())
	}
	if err := e.Verify(1_000_000); err != nil {
		t.Fatal(err)
	}
}

func TestSnapshotIsolationAndDiff(t *testing.T) {
	e := NewEngine(2, 2, 2)
	_ = e.SetA(0, 0, 2)
	_ = e.SetB(0, 1, 3)
	e.Snapshot("v1")

	_ = e.SetA(0, 0, 5) // C[0][1]: 6 -> 15
	_ = e.SetB(1, 1, 7) // new B entry, no C change (A col 1 empty)
	e.Snapshot("v2")

	// v1 must be unaffected by the later mutations.
	changes, err := e.Diff("v1", "v2")
	if err != nil {
		t.Fatal(err)
	}
	want := []Change{
		{Matrix: "A", R: 0, C: 0, Old: 2, New: 5},
		{Matrix: "B", R: 1, C: 1, Old: 0, New: 7},
		{Matrix: "C", R: 0, C: 1, Old: 6, New: 15},
	}
	if len(changes) != len(want) {
		t.Fatalf("got %d changes %v, want %d", len(changes), changes, len(want))
	}
	for i := range want {
		if changes[i] != want[i] {
			t.Errorf("change %d: got %+v, want %+v", i, changes[i], want[i])
		}
	}
	if _, err := e.Diff("v1", "nope"); err == nil {
		t.Fatal("diff with unknown snapshot should fail")
	}
}

func TestUndo(t *testing.T) {
	e := NewEngine(3, 3, 3)
	_ = e.SetA(0, 0, 2)
	_ = e.SetA(1, 2, -4)
	_ = e.SetB(2, 1, 6)
	before := e.C.Clone()
	aBefore := e.A.Clone()
	bBefore := e.B.Clone()

	_ = e.SetA(0, 0, 10)
	_ = e.SetB(2, 1, 0)
	_ = e.SetA(2, 2, 8)

	for i := 0; i < 3; i++ {
		ok, err := e.Undo()
		if err != nil || !ok {
			t.Fatalf("undo failed: ok=%v err=%v", ok, err)
		}
	}
	if !e.A.Equal(aBefore) || !e.B.Equal(bBefore) || !e.C.Equal(before) {
		t.Fatal("undo did not restore A, B and C")
	}
	if e.UndoDepth() != 3 {
		t.Fatalf("undo depth = %d, want 3", e.UndoDepth())
	}
	for e.UndoDepth() > 0 {
		if ok, err := e.Undo(); !ok || err != nil {
			t.Fatalf("drain undo failed: ok=%v err=%v", ok, err)
		}
	}
	if ok, _ := e.Undo(); ok {
		t.Fatal("undo on empty history should report false")
	}
}

func TestOverflowAtomicity(t *testing.T) {
	e := NewEngine(1, 2, 1)
	_ = e.SetA(0, 0, math.MaxInt64)
	_ = e.SetB(0, 0, 2)
	err := e.SetA(0, 1, math.MaxInt64)
	_ = e.SetB(1, 0, 2) // now C would overflow on next change? no: apply B first
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	// Force an overflow: delta * B value overflows.
	e2 := NewEngine(1, 1, 1)
	_ = e2.SetB(0, 0, 2)
	depth := e2.UndoDepth()
	if err := e2.SetA(0, 0, math.MaxInt64); !errors.Is(err, ErrOverflow) {
		t.Fatalf("want overflow, got %v", err)
	}
	// State must be untouched after the failed correction.
	if e2.A.NNZ() != 0 || e2.C.NNZ() != 0 {
		t.Fatal("failed set mutated engine state")
	}
	if e2.UndoDepth() != depth {
		t.Fatal("failed set was recorded in history")
	}
}

func TestSaveLoadRoundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	e := NewEngine(2, 3, 2)
	_ = e.SetA(0, 1, 4)
	_ = e.SetB(1, 0, -3)
	e.Snapshot("s1")
	_ = e.SetA(1, 2, 5)
	if err := e.Save(path); err != nil {
		t.Fatal(err)
	}
	g, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !g.A.Equal(e.A) || !g.B.Equal(e.B) || !g.C.Equal(e.C) {
		t.Fatal("matrices differ after load")
	}
	if g.UndoDepth() != e.UndoDepth() {
		t.Fatalf("undo depth %d, want %d", g.UndoDepth(), e.UndoDepth())
	}
	changes, err := g.Diff("s1", "s1")
	if err != nil || len(changes) != 0 {
		t.Fatalf("self diff: %v %v", changes, err)
	}
	// Undo must work across the save/load boundary.
	ok, err := g.Undo()
	if !ok || err != nil {
		t.Fatalf("undo after load: ok=%v err=%v", ok, err)
	}
	if g.A.Get(1, 2) != 0 {
		t.Fatal("undo after load did not revert A[1][2]")
	}
}

func TestVerifyRefusesLargeMatrices(t *testing.T) {
	e := NewEngine(100, 100, 100)
	if err := e.Verify(1000); err == nil {
		t.Fatal("verify should refuse when dense cost exceeds limit")
	}
}
