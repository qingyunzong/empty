package matrixlib

import (
	"errors"
	"math"
	"math/rand"
	"testing"
)

func TestNaiveMultiplyKnown(t *testing.T) {
	// A = [[1, 2], [3, 4]], B = [[5, 6], [7, 8]]
	// C = [[19, 22], [43, 50]]
	a := NewMatrix(2, 2)
	mustSet(t, a, 0, 0, 1)
	mustSet(t, a, 0, 1, 2)
	mustSet(t, a, 1, 0, 3)
	mustSet(t, a, 1, 1, 4)
	b := NewMatrix(2, 2)
	mustSet(t, b, 0, 0, 5)
	mustSet(t, b, 0, 1, 6)
	mustSet(t, b, 1, 0, 7)
	mustSet(t, b, 1, 1, 8)
	c, err := NaiveMultiply(a, b)
	if err != nil {
		t.Fatal(err)
	}
	want := [][]int64{{19, 22}, {43, 50}}
	for i := 0; i < 2; i++ {
		for j := 0; j < 2; j++ {
			if got := c.Get(i, j); got != want[i][j] {
				t.Fatalf("C(%d,%d) = %d, want %d", i, j, got, want[i][j])
			}
		}
	}
}

// TestIncrementalMatchesNaive applies random single-element corrections
// (including zero deletions) and checks the incremental C against the naive
// triple-loop product after every step.
func TestIncrementalMatchesNaive(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 30; trial++ {
		ar, ac, bc := 1+rng.Intn(6), 1+rng.Intn(6), 1+rng.Intn(6)
		eng := NewEngine(ar, ac, bc)
		for step := 0; step < 200; step++ {
			// Values stay small so overflow cannot trigger here.
			v := int64(rng.Intn(21) - 10)
			if rng.Intn(2) == 0 {
				if err := eng.SetA(rng.Intn(ar), rng.Intn(ac), v); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := eng.SetB(rng.Intn(ac), rng.Intn(bc), v); err != nil {
					t.Fatal(err)
				}
			}
			if err := eng.Check(); err != nil {
				t.Fatalf("trial %d step %d: %v", trial, step, err)
			}
		}
	}
}

// TestUndoRestoresState verifies that undoing every correction returns the
// engine to a byte-for-byte identical state.
func TestUndoRestoresState(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	eng := NewEngine(4, 5, 3)
	var states [][3]*Matrix
	record := func() {
		states = append(states, [3]*Matrix{eng.A.Clone(), eng.B.Clone(), eng.C.Clone()})
	}
	record()
	const steps = 120
	for i := 0; i < steps; i++ {
		v := int64(rng.Intn(11) - 5)
		if rng.Intn(2) == 0 {
			r, c := rng.Intn(4), rng.Intn(5)
			if eng.A.Get(r, c) == v {
				continue // no-op sets are not recorded in history
			}
			if err := eng.SetA(r, c, v); err != nil {
				t.Fatal(err)
			}
		} else {
			r, c := rng.Intn(5), rng.Intn(3)
			if eng.B.Get(r, c) == v {
				continue
			}
			if err := eng.SetB(r, c, v); err != nil {
				t.Fatal(err)
			}
		}
		record()
	}
	if eng.PendingUndo() != len(states)-1 {
		t.Fatalf("pending undo = %d, want %d", eng.PendingUndo(), len(states)-1)
	}
	for i := len(states) - 1; i >= 1; i-- {
		if !eng.Undo() {
			t.Fatalf("undo %d reported nothing to undo", i)
		}
		prev := states[i-1]
		if !eng.A.Equal(prev[0]) || !eng.B.Equal(prev[1]) || !eng.C.Equal(prev[2]) {
			t.Fatalf("state after undo %d differs from recorded state", i)
		}
	}
	if eng.Undo() {
		t.Fatal("undo on empty history should report false")
	}
}

// TestSnapshotIsolation ensures snapshots are not affected by later changes.
func TestSnapshotIsolation(t *testing.T) {
	eng := NewEngine(2, 2, 2)
	if err := eng.SetA(0, 0, 3); err != nil {
		t.Fatal(err)
	}
	if err := eng.SetB(0, 1, 4); err != nil {
		t.Fatal(err)
	}
	id := eng.Snapshot()
	if err := eng.SetA(0, 0, 10); err != nil {
		t.Fatal(err)
	}
	if err := eng.SetB(1, 1, 2); err != nil {
		t.Fatal(err)
	}
	eng.Undo()
	snap := eng.SnapshotByID(id)
	if snap == nil {
		t.Fatal("snapshot missing")
	}
	if got := snap.A.Get(0, 0); got != 3 {
		t.Fatalf("snapshot A(0,0) = %d, want 3", got)
	}
	if got := snap.B.Get(1, 1); got != 0 {
		t.Fatalf("snapshot B(1,1) = %d, want 0", got)
	}
	if got := snap.C.Get(0, 1); got != 12 {
		t.Fatalf("snapshot C(0,1) = %d, want 12", got)
	}
}

// TestOverflowRejected verifies that an overflowing correction is rejected
// and leaves A, B and C untouched.
func TestOverflowRejected(t *testing.T) {
	eng := NewEngine(1, 1, 1)
	if err := eng.SetB(0, 0, 2); err != nil {
		t.Fatal(err)
	}
	// C(0,0) would be MaxInt64*2: must be rejected.
	before := [3]*Matrix{eng.A.Clone(), eng.B.Clone(), eng.C.Clone()}
	err := eng.SetA(0, 0, math.MaxInt64)
	if !errors.Is(err, ErrOverflow) {
		t.Fatalf("err = %v, want ErrOverflow", err)
	}
	if !eng.A.Equal(before[0]) || !eng.B.Equal(before[1]) || !eng.C.Equal(before[2]) {
		t.Fatal("state changed after rejected update")
	}
	if eng.PendingUndo() != 1 {
		t.Fatalf("rejected update recorded in history: %d", eng.PendingUndo())
	}
	// A legal correction still works afterwards.
	if err := eng.SetA(0, 0, 1); err != nil {
		t.Fatal(err)
	}
	if got := eng.C.Get(0, 0); got != 2 {
		t.Fatalf("C(0,0) = %d, want 2", got)
	}
}

// TestOverflowOnAccumulation: each product fits but the sum overflows.
func TestOverflowOnAccumulation(t *testing.T) {
	eng := NewEngine(1, 2, 1)
	if err := eng.SetA(0, 0, math.MaxInt64); err != nil {
		t.Fatal(err)
	}
	if err := eng.SetB(0, 0, 1); err != nil {
		t.Fatal(err)
	}
	if err := eng.SetA(0, 1, 1); err != nil {
		t.Fatal(err)
	}
	// C(0,0) = MaxInt64 + 1*1 overflows.
	err := eng.SetB(1, 0, 1)
	if !errors.Is(err, ErrOverflow) {
		t.Fatalf("err = %v, want ErrOverflow", err)
	}
	if got := eng.C.Get(0, 0); got != math.MaxInt64 {
		t.Fatalf("C(0,0) = %d, want %d", got, int64(math.MaxInt64))
	}
	if got := eng.B.Get(1, 0); got != 0 {
		t.Fatalf("B(1,0) = %d, want 0 (rejected update must not apply)", got)
	}
	if eng.PendingUndo() != 3 {
		t.Fatalf("rejected update recorded in history: %d", eng.PendingUndo())
	}
}

func TestDiff(t *testing.T) {
	eng := NewEngine(2, 2, 2)
	if err := eng.SetA(0, 0, 1); err != nil {
		t.Fatal(err)
	}
	id1 := eng.Snapshot()
	if err := eng.SetA(0, 0, 5); err != nil { // modify existing
		t.Fatal(err)
	}
	if err := eng.SetB(1, 1, 7); err != nil { // add new
		t.Fatal(err)
	}
	id2 := eng.Snapshot()
	if err := eng.SetA(0, 0, 0); err != nil { // delete
		t.Fatal(err)
	}

	changes, err := eng.DiffSnapshots(id1, id2)
	if err != nil {
		t.Fatal(err)
	}
	want := []Change{
		{Matrix: "A", Row: 0, Col: 0, From: 1, To: 5},
		{Matrix: "B", Row: 1, Col: 1, From: 0, To: 7},
	}
	if len(changes) != len(want) {
		t.Fatalf("diff = %v, want %v", changes, want)
	}
	for i, w := range want {
		if changes[i] != w {
			t.Fatalf("diff[%d] = %+v, want %+v", i, changes[i], w)
		}
	}

	cur, err := eng.DiffCurrent(id2)
	if err != nil {
		t.Fatal(err)
	}
	// A(0,0) went 5 -> 0 (deleted); C unchanged (B column 0 is zero).
	found := false
	for _, ch := range cur {
		if ch.Matrix == "A" && ch.Row == 0 && ch.Col == 0 && ch.From == 5 && ch.To == 0 {
			found = true
		}
	}
	if !found {
		t.Fatalf("deletion not reported in diff: %v", cur)
	}

	if _, err := eng.DiffSnapshots(id1, 999); err == nil {
		t.Fatal("expected error for unknown snapshot id")
	}
}

func TestOutOfRangeCorrections(t *testing.T) {
	eng := NewEngine(2, 2, 2)
	if err := eng.SetA(5, 0, 1); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("SetA err = %v, want ErrOutOfRange", err)
	}
	if err := eng.SetB(0, -1, 1); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("SetB err = %v, want ErrOutOfRange", err)
	}
	if eng.PendingUndo() != 0 {
		t.Fatal("out-of-range correction recorded in history")
	}
}
