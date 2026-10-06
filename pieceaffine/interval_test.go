package pieceaffine

import "testing"

func TestCanonical(t *testing.T) {
	got := Canonical([]Interval{
		{Lo: 5, Hi: 5}, // empty, dropped
		{Lo: 4, Hi: 6},
		{Lo: 0, Hi: 2},
		{Lo: 2, Hi: 4}, // adjacent to both neighbors, merges all
		{Lo: 9, Hi: 10},
		{Lo: 8, Hi: 9}, // adjacent, merges
		{Lo: -3, Hi: -1},
	})
	want := []Interval{{Lo: -3, Hi: -1}, {Lo: 0, Hi: 6}, {Lo: 8, Hi: 10}}
	if !equalIntervals(got, want) {
		t.Fatalf("Canonical = %v, want %v", got, want)
	}
	if got := Canonical(nil); len(got) != 0 {
		t.Fatalf("Canonical(nil) = %v, want empty", got)
	}
}

func TestIntervalBasics(t *testing.T) {
	iv := Interval{Lo: -2, Hi: 3}
	if iv.Empty() || iv.Len() != 5 {
		t.Fatalf("Len = %d, want 5", iv.Len())
	}
	if !iv.Contains(-2) || !iv.Contains(2) || iv.Contains(3) {
		t.Fatalf("Contains wrong for %v", iv)
	}
	if (Interval{Lo: 3, Hi: 3}).Len() != 0 {
		t.Fatal("empty interval must have Len 0")
	}
}
