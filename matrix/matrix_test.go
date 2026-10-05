package matrix

import (
	"errors"
	"math"
	"math/rand"
	"testing"
)

func TestCheckedArithmetic(t *testing.T) {
	if _, err := checkedAdd(math.MaxInt64, 1); !errors.Is(err, ErrOverflow) {
		t.Errorf("add MaxInt64+1: want overflow, got %v", err)
	}
	if _, err := checkedAdd(math.MinInt64, -1); !errors.Is(err, ErrOverflow) {
		t.Errorf("add MinInt64-1: want overflow, got %v", err)
	}
	if v, err := checkedAdd(math.MaxInt64, -1); err != nil || v != math.MaxInt64-1 {
		t.Errorf("add MaxInt64-1: got %d, %v", v, err)
	}
	if _, err := checkedSub(math.MinInt64, 1); !errors.Is(err, ErrOverflow) {
		t.Errorf("sub MinInt64-1: want overflow, got %v", err)
	}
	if _, err := checkedSub(0, math.MinInt64); !errors.Is(err, ErrOverflow) {
		t.Errorf("sub 0-MinInt64: want overflow, got %v", err)
	}
	if v, err := checkedSub(-5, math.MinInt64); err != nil || v != math.MaxInt64-4 {
		t.Errorf("sub -5-MinInt64: got %d, %v", v, err)
	}
	if _, err := checkedMul(math.MaxInt64, 2); !errors.Is(err, ErrOverflow) {
		t.Errorf("mul MaxInt64*2: want overflow, got %v", err)
	}
	if _, err := checkedMul(math.MinInt64, -1); !errors.Is(err, ErrOverflow) {
		t.Errorf("mul MinInt64*-1: want overflow, got %v", err)
	}
	if _, err := checkedMul(-1, math.MinInt64); !errors.Is(err, ErrOverflow) {
		t.Errorf("mul -1*MinInt64: want overflow, got %v", err)
	}
	if v, err := checkedMul(math.MinInt64, 1); err != nil || v != math.MinInt64 {
		t.Errorf("mul MinInt64*1: got %d, %v", v, err)
	}
	if v, err := checkedMul(-6, 7); err != nil || v != -42 {
		t.Errorf("mul -6*7: got %d, %v", v, err)
	}
}

func TestSetGetZeroDeletes(t *testing.T) {
	m := New(3, 3)
	if err := m.Set(1, 2, 9); err != nil {
		t.Fatal(err)
	}
	if got := m.Get(1, 2); got != 9 {
		t.Fatalf("Get = %d, want 9", got)
	}
	if m.NNZ() != 1 {
		t.Fatalf("NNZ = %d, want 1", m.NNZ())
	}
	if err := m.Set(1, 2, 0); err != nil {
		t.Fatal(err)
	}
	if m.NNZ() != 0 || m.Get(1, 2) != 0 {
		t.Fatalf("zero set did not delete entry, NNZ=%d", m.NNZ())
	}
	if err := m.Set(3, 0, 1); err == nil {
		t.Fatal("out-of-bounds set should fail")
	}
	if err := m.Set(-1, 0, 1); err == nil {
		t.Fatal("negative index set should fail")
	}
}

func TestCloneIsolation(t *testing.T) {
	m := New(2, 2)
	_ = m.Set(0, 1, 5)
	c := m.Clone()
	_ = m.Set(0, 1, 7)
	_ = m.Set(1, 1, 3)
	if c.Get(0, 1) != 5 || c.Get(1, 1) != 0 {
		t.Fatal("clone changed after mutating original")
	}
}

func randomMatrix(r *rand.Rand, rows, cols int, density float64, maxVal int64) *Matrix {
	m := New(rows, cols)
	for i := 0; i < rows; i++ {
		for j := 0; j < cols; j++ {
			if r.Float64() < density {
				v := r.Int63n(2*maxVal+1) - maxVal
				if v != 0 {
					_ = m.Set(i, j, v)
				}
			}
		}
	}
	return m
}

func TestMultiplyMatchesNaive(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	for trial := 0; trial < 200; trial++ {
		m, k, n := 1+r.Intn(6), 1+r.Intn(6), 1+r.Intn(6)
		a := randomMatrix(r, m, k, 0.5, 100)
		b := randomMatrix(r, k, n, 0.5, 100)
		fast, err := Multiply(a, b)
		if err != nil {
			t.Fatalf("trial %d: Multiply: %v", trial, err)
		}
		slow, err := NaiveMultiply(a, b)
		if err != nil {
			t.Fatalf("trial %d: NaiveMultiply: %v", trial, err)
		}
		if !fast.Equal(slow) {
			t.Fatalf("trial %d: sparse and naive multiply disagree", trial)
		}
	}
}

func TestMultiplyDimMismatch(t *testing.T) {
	a, b := New(2, 3), New(4, 2)
	if _, err := Multiply(a, b); err == nil {
		t.Fatal("dimension mismatch should fail")
	}
	if _, err := NaiveMultiply(a, b); err == nil {
		t.Fatal("naive dimension mismatch should fail")
	}
}

func TestMultiplyOverflow(t *testing.T) {
	a, b := New(1, 1), New(1, 1)
	_ = a.Set(0, 0, math.MaxInt64)
	_ = b.Set(0, 0, 2)
	if _, err := Multiply(a, b); !errors.Is(err, ErrOverflow) {
		t.Fatalf("want overflow, got %v", err)
	}
	// Accumulation overflow: two large products summing past MaxInt64.
	a2, b2 := New(1, 2), New(2, 1)
	_ = a2.Set(0, 0, math.MaxInt64-3)
	_ = a2.Set(0, 1, math.MaxInt64-3)
	_ = b2.Set(0, 0, 1)
	_ = b2.Set(1, 0, 1)
	if _, err := Multiply(a2, b2); !errors.Is(err, ErrOverflow) {
		t.Fatalf("accumulation: want overflow, got %v", err)
	}
}

func TestDiffMatrices(t *testing.T) {
	m1, m2 := New(2, 2), New(2, 2)
	_ = m1.Set(0, 0, 1)
	_ = m1.Set(1, 1, 2)
	_ = m2.Set(0, 0, 1)
	_ = m2.Set(1, 1, 5)
	_ = m2.Set(0, 1, 7)
	changes := DiffMatrices("A", m1, m2)
	if len(changes) != 2 {
		t.Fatalf("got %d changes, want 2", len(changes))
	}
	if changes[0] != (Change{Matrix: "A", R: 0, C: 1, Old: 0, New: 7}) {
		t.Errorf("unexpected change %+v", changes[0])
	}
	if changes[1] != (Change{Matrix: "A", R: 1, C: 1, Old: 2, New: 5}) {
		t.Errorf("unexpected change %+v", changes[1])
	}
	if d := DiffMatrices("A", m1, m1.Clone()); len(d) != 0 {
		t.Errorf("identical matrices: got %d changes", len(d))
	}
}
