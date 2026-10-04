package matrixlib

import (
	"errors"
	"math"
	"testing"
)

func TestSetGetAndZeroDeletion(t *testing.T) {
	m := NewMatrix(3, 4)
	if err := m.Set(1, 2, 7); err != nil {
		t.Fatal(err)
	}
	if got := m.Get(1, 2); got != 7 {
		t.Fatalf("Get = %d, want 7", got)
	}
	if got := len(m.Entries()); got != 1 {
		t.Fatalf("entries = %d, want 1", got)
	}
	// Setting zero deletes the entry.
	if err := m.Set(1, 2, 0); err != nil {
		t.Fatal(err)
	}
	if got := m.Get(1, 2); got != 0 {
		t.Fatalf("Get after delete = %d, want 0", got)
	}
	if got := len(m.Entries()); got != 0 {
		t.Fatalf("entries after delete = %d, want 0", got)
	}
	if got := len(m.RowEntries(1)); got != 0 {
		t.Fatalf("row entries after delete = %d, want 0", got)
	}
	if got := len(m.ColEntries(2)); got != 0 {
		t.Fatalf("col entries after delete = %d, want 0", got)
	}
}

func TestSetOutOfRange(t *testing.T) {
	m := NewMatrix(2, 2)
	for _, rc := range [][2]int{{-1, 0}, {0, -1}, {2, 0}, {0, 2}} {
		if err := m.Set(rc[0], rc[1], 1); !errors.Is(err, ErrOutOfRange) {
			t.Fatalf("Set(%d,%d) err = %v, want ErrOutOfRange", rc[0], rc[1], err)
		}
	}
}

func TestCloneIsolation(t *testing.T) {
	m := NewMatrix(2, 2)
	mustSet(t, m, 0, 0, 5)
	cp := m.Clone()
	mustSet(t, m, 0, 0, 9)
	mustSet(t, m, 1, 1, 3)
	if got := cp.Get(0, 0); got != 5 {
		t.Fatalf("clone changed: got %d, want 5", got)
	}
	if got := cp.Get(1, 1); got != 0 {
		t.Fatalf("clone gained entry: got %d, want 0", got)
	}
}

func TestCheckedArithmetic(t *testing.T) {
	cases := []struct {
		a, b int64
		want int64
		ov   bool
	}{
		{3, 4, 12, false},
		{-3, 4, -12, false},
		{3, -4, -12, false},
		{-3, -4, 12, false},
		{0, math.MinInt64, 0, false},
		{math.MaxInt64, 1, math.MaxInt64, false},
		{math.MaxInt64, 2, 0, true},
		{math.MinInt64, -1, 0, true},
		{math.MinInt64, 1, math.MinInt64, false},
		{1 << 32, 1 << 32, 0, true},
		{1 << 31, 1 << 31, 1 << 62, false},
	}
	for _, c := range cases {
		got, ov := mulChecked(c.a, c.b)
		if ov != c.ov || (!ov && got != c.want) {
			t.Errorf("mulChecked(%d, %d) = %d, %v; want %d, %v", c.a, c.b, got, ov, c.want, c.ov)
		}
	}

	adds := []struct {
		a, b int64
		want int64
		ov   bool
	}{
		{1, 2, 3, false},
		{math.MaxInt64, 1, 0, true},
		{math.MinInt64, -1, 0, true},
		{math.MaxInt64, -1, math.MaxInt64 - 1, false},
		{math.MinInt64, 1, math.MinInt64 + 1, false},
		{math.MaxInt64, math.MinInt64, -1, false},
	}
	for _, c := range adds {
		got, ov := addChecked(c.a, c.b)
		if ov != c.ov || (!ov && got != c.want) {
			t.Errorf("addChecked(%d, %d) = %d, %v; want %d, %v", c.a, c.b, got, ov, c.want, c.ov)
		}
	}

	subs := []struct {
		a, b int64
		want int64
		ov   bool
	}{
		{5, 3, 2, false},
		{math.MinInt64, 1, 0, true},
		{math.MaxInt64, -1, 0, true},
		{0, math.MinInt64, 0, true},
		{math.MinInt64, math.MinInt64, 0, false},
	}
	for _, c := range subs {
		got, ov := subChecked(c.a, c.b)
		if ov != c.ov || (!ov && got != c.want) {
			t.Errorf("subChecked(%d, %d) = %d, %v; want %d, %v", c.a, c.b, got, ov, c.want, c.ov)
		}
	}
}

func mustSet(t *testing.T, m *Matrix, r, c int, v int64) {
	t.Helper()
	if err := m.Set(r, c, v); err != nil {
		t.Fatalf("Set(%d,%d,%d): %v", r, c, v, err)
	}
}
