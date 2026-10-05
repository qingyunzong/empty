package trendlib

import (
	"math/big"
	"testing"
)

func rat(t *testing.T, s string) *big.Rat {
	t.Helper()
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		t.Fatalf("bad rational %q", s)
	}
	return r
}

func mustQuery(t *testing.T, ix *Index, lo, hi int64, v int) (*big.Rat, *big.Rat) {
	t.Helper()
	slope, rss, err := ix.Query(lo, hi, v)
	if err != nil {
		t.Fatalf("Query(%d, %d, %d): %v", lo, hi, v, err)
	}
	return slope, rss
}

func TestExactFractionalSlopeAndRSS(t *testing.T) {
	ix := NewIndex([]Sample{{0, 0}, {1, 0}, {2, 1}})
	slope, rss := mustQuery(t, ix, 0, 3, 0)
	if slope == nil || slope.Cmp(rat(t, "1/2")) != 0 {
		t.Fatalf("slope = %v, want 1/2", slope)
	}
	if rss.Cmp(rat(t, "1/6")) != 0 {
		t.Fatalf("rss = %v, want 1/6", rss)
	}
}

func TestZeroVarianceReturnsNoSlope(t *testing.T) {
	// All samples share one timestamp: no x variance, so no slope; rss is
	// the squared deviation from the mean value 2.
	ix := NewIndex([]Sample{{5, 1}, {5, 3}, {5, 2}})
	slope, rss := mustQuery(t, ix, 5, 6, 0)
	if slope != nil {
		t.Fatalf("slope = %v, want nil", slope)
	}
	if rss.Cmp(rat(t, "2")) != 0 {
		t.Fatalf("rss = %v, want 2", rss)
	}

	// A single sample has no slope and zero residual.
	slope, rss = mustQuery(t, ix, 5, 6, 0)
	if slope != nil {
		t.Fatalf("single-distinct-x slope = %v, want nil", slope)
	}
	empty := NewIndex(nil)
	slope, rss = mustQuery(t, empty, 0, 10, 0)
	if slope != nil || rss.Sign() != 0 {
		t.Fatalf("empty range: slope=%v rss=%v, want nil and 0", slope, rss)
	}
}

func TestRangeEdgeInterpolation(t *testing.T) {
	ix := NewIndex([]Sample{{0, 0}, {10, 20}, {20, 0}})
	// Interior sample (10,20) plus interpolated edge points (5,10) and
	// (15,10): symmetric, so slope 0 and rss 200/3.
	slope, rss := mustQuery(t, ix, 5, 15, 0)
	if slope == nil || slope.Sign() != 0 {
		t.Fatalf("slope = %v, want 0", slope)
	}
	if rss.Cmp(rat(t, "200/3")) != 0 {
		t.Fatalf("rss = %v, want 200/3", rss)
	}
}

func TestHalfOpenRangeBoundaries(t *testing.T) {
	ix := NewIndex([]Sample{{0, 1}, {10, 3}, {20, 100}})
	// [0,20): sample at lo included, sample at hi excluded, no edge
	// interpolation because samples sit exactly on both edges.
	slope, rss := mustQuery(t, ix, 0, 20, 0)
	if slope == nil || slope.Cmp(rat(t, "1/5")) != 0 {
		t.Fatalf("slope = %v, want 1/5", slope)
	}
	if rss.Sign() != 0 {
		t.Fatalf("rss = %v, want 0", rss)
	}
	// [0,21): all three samples participate.
	slope, rss = mustQuery(t, ix, 0, 21, 0)
	if slope == nil || slope.Cmp(rat(t, "99/20")) != 0 {
		t.Fatalf("slope = %v, want 99/20", slope)
	}
	if rss.Cmp(rat(t, "9025/6")) != 0 {
		t.Fatalf("rss = %v, want 9025/6", rss)
	}
}

func TestDuplicateTimestamps(t *testing.T) {
	ix := NewIndex([]Sample{{0, 0}, {0, 4}, {10, 10}})
	// [0,11): duplicates at t=0 participate individually.
	slope, rss := mustQuery(t, ix, 0, 11, 0)
	if slope == nil || slope.Cmp(rat(t, "4/5")) != 0 {
		t.Fatalf("slope = %v, want 4/5", slope)
	}
	if rss.Cmp(rat(t, "8")) != 0 {
		t.Fatalf("rss = %v, want 8", rss)
	}
	// [5,10): no interior samples; edge at 5 interpolates between the mean
	// at t=0 (=2) and t=10 (=10) giving (5,6); edge at 10 has an exact
	// sample so no interpolation. One point only: no slope, zero residual.
	slope, rss = mustQuery(t, ix, 5, 10, 0)
	if slope != nil {
		t.Fatalf("slope = %v, want nil", slope)
	}
	if rss.Sign() != 0 {
		t.Fatalf("rss = %v, want 0", rss)
	}
}

func TestQueryRejectsUnknownVersion(t *testing.T) {
	ix := NewIndex([]Sample{{0, 0}})
	if _, _, err := ix.Query(0, 1, 1); err == nil {
		t.Fatal("expected error for future version")
	}
	if _, _, err := ix.Query(0, 1, -1); err == nil {
		t.Fatal("expected error for negative version")
	}
}
