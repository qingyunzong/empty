package permset

import (
	"math"
	"testing"
)

func checkCanonical(t *testing.T, s Set) {
	t.Helper()
	ivs := s.ivs
	for i, iv := range ivs {
		if iv.Lo > iv.Hi {
			t.Fatalf("non-canonical: empty interval %v", iv)
		}
		if i == 0 {
			continue
		}
		prev := ivs[i-1]
		if prev.Lo >= iv.Lo {
			t.Fatalf("non-canonical: not sorted at %v, %v", prev, iv)
		}
		// Gap must be at least 2; guarded against Hi+1 overflow.
		if prev.Hi == math.MaxInt64 || prev.Hi+1 >= iv.Lo {
			t.Fatalf("non-canonical: %v and %v overlap or are adjacent", prev, iv)
		}
	}
}

func TestNormMergesOverlappingAndAdjacent(t *testing.T) {
	got := Norm([]Interval{{5, 6}, {1, 2}, {3, 4}, {10, 10}})
	want := Set{ivs: []Interval{{1, 6}, {10, 10}}}
	if !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	checkCanonical(t, got)
}

func TestNormKeepsGaps(t *testing.T) {
	got := Norm([]Interval{{1, 2}, {4, 5}, {8, 8}})
	if len(got.ivs) != 3 {
		t.Fatalf("got %v, want 3 intervals", got)
	}
	checkCanonical(t, got)
}

func TestNormAdjacentMergeAtMaxInt64(t *testing.T) {
	// Merging [0, MaxInt64-1] with [MaxInt64, MaxInt64] must not overflow
	// on the Hi+1 adjacency probe.
	got := Norm([]Interval{{0, math.MaxInt64 - 1}, {math.MaxInt64, math.MaxInt64}})
	want := Set{ivs: []Interval{{0, math.MaxInt64}}}
	if !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	checkCanonical(t, got)
}

func TestNormAdjacentMergeAtMinInt64(t *testing.T) {
	got := Norm([]Interval{{math.MinInt64 + 1, 5}, {math.MinInt64, math.MinInt64}})
	want := Set{ivs: []Interval{{math.MinInt64, 5}}}
	if !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	checkCanonical(t, got)
}

func TestUnionFullRangeFromHalves(t *testing.T) {
	got := Norm([]Interval{{math.MinInt64, -1}}).Union(Norm([]Interval{{0, math.MaxInt64}}))
	want := Set{ivs: []Interval{{math.MinInt64, math.MaxInt64}}}
	if !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	checkCanonical(t, got)
}

func TestIntersectBasic(t *testing.T) {
	a := Norm([]Interval{{1, 5}, {10, 20}})
	b := Norm([]Interval{{3, 12}})
	want := Set{ivs: []Interval{{3, 5}, {10, 12}}}
	if got := a.Intersect(b); !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if got := a.Intersect(Norm([]Interval{{6, 9}})); !got.Empty() {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestIntersectExtremes(t *testing.T) {
	a := Norm([]Interval{{math.MinInt64, math.MinInt64 + 5}})
	b := Norm([]Interval{{math.MinInt64 + 3, math.MaxInt64}})
	want := Set{ivs: []Interval{{math.MinInt64 + 3, math.MinInt64 + 5}}}
	if got := a.Intersect(b); !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestDiffSplitMiddle(t *testing.T) {
	a := Norm([]Interval{{1, 10}})
	b := Norm([]Interval{{4, 5}})
	want := Set{ivs: []Interval{{1, 3}, {6, 10}}}
	if got := a.Diff(b); !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	checkCanonical(t, a.Diff(b))
}

func TestDiffRemovesMaxEndpoint(t *testing.T) {
	// Removing the point MaxInt64 must produce Hi = MaxInt64-1 without
	// ever computing MaxInt64+1.
	a := Norm([]Interval{{0, math.MaxInt64}})
	got := a.Diff(Norm([]Interval{{math.MaxInt64, math.MaxInt64}}))
	want := Set{ivs: []Interval{{0, math.MaxInt64 - 1}}}
	if !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	got = a.Diff(Norm([]Interval{{math.MaxInt64 - 2, math.MaxInt64}}))
	want = Set{ivs: []Interval{{0, math.MaxInt64 - 3}}}
	if !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	checkCanonical(t, got)
}

func TestDiffRemovesMinEndpoint(t *testing.T) {
	a := Norm([]Interval{{math.MinInt64, 10}})
	got := a.Diff(Norm([]Interval{{math.MinInt64, math.MinInt64}}))
	want := Set{ivs: []Interval{{math.MinInt64 + 1, 10}}}
	if !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	checkCanonical(t, got)
}

func TestDiffFullRangeMinusPoint(t *testing.T) {
	full := Norm([]Interval{{math.MinInt64, math.MaxInt64}})
	got := full.Diff(Norm([]Interval{{0, 0}}))
	want := Set{ivs: []Interval{{math.MinInt64, -1}, {1, math.MaxInt64}}}
	if !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	checkCanonical(t, got)
	if got := full.Diff(full); !got.Empty() {
		t.Fatalf("got %v, want empty", got)
	}
}

func TestDiffMultiInterval(t *testing.T) {
	a := Norm([]Interval{{1, 5}, {10, 15}, {20, 25}})
	b := Norm([]Interval{{3, 12}, {22, 30}})
	want := Set{ivs: []Interval{{1, 2}, {13, 15}, {20, 21}}}
	if got := a.Diff(b); !got.Equal(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	checkCanonical(t, a.Diff(b))
}

func TestContainsAtExtremes(t *testing.T) {
	full := Norm([]Interval{{math.MinInt64, math.MaxInt64}})
	for _, x := range []int64{math.MinInt64, math.MinInt64 + 1, -1, 0, 1, math.MaxInt64 - 1, math.MaxInt64} {
		if !full.Contains(x) {
			t.Fatalf("full range should contain %d", x)
		}
	}
	s := Norm([]Interval{{1, 3}, {10, 10}})
	for _, x := range []int64{1, 2, 3, 10} {
		if !s.Contains(x) {
			t.Fatalf("%v should contain %d", s, x)
		}
	}
	for _, x := range []int64{0, 4, 9, 11} {
		if s.Contains(x) {
			t.Fatalf("%v should not contain %d", s, x)
		}
	}
}

func TestSetString(t *testing.T) {
	s := Norm([]Interval{{1, 2}, {5, 5}})
	if got, want := s.String(), "{[1,2], [5]}"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if got := (Set{}).String(); got != "{}" {
		t.Fatalf("got %q, want {}", got)
	}
}
