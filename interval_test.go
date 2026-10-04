package permset

import (
	"math"
	"slices"
	"testing"
)

func TestNormalizeMergesAdjacent(t *testing.T) {
	got := Normalize([]Interval{{6, 10}, {0, 5}, {20, 25}, {12, 18}})
	want := []Interval{{0, 10}, {12, 18}, {20, 25}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// Adjacent merge must not overflow when the running Hi is MaxInt64.
func TestUnionAdjacencyAtMaxInt64(t *testing.T) {
	got := Union(
		[]Interval{{0, math.MaxInt64 - 1}},
		[]Interval{{math.MaxInt64, math.MaxInt64}},
	)
	want := []Interval{{0, math.MaxInt64}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestUnionAdjacencyAtMinInt64(t *testing.T) {
	got := Union(
		[]Interval{{math.MinInt64, math.MinInt64}},
		[]Interval{{math.MinInt64 + 1, 5}},
	)
	want := []Interval{{math.MinInt64, 5}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestNormalizeFullRange(t *testing.T) {
	got := Normalize([]Interval{{math.MinInt64, math.MaxInt64}, {0, 0}})
	want := []Interval{{math.MinInt64, math.MaxInt64}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

// Removing a single endpoint at MaxInt64 must not wrap around.
func TestSubtractMaxEndpoint(t *testing.T) {
	got := Subtract(
		[]Interval{{0, math.MaxInt64}},
		[]Interval{{math.MaxInt64, math.MaxInt64}},
	)
	want := []Interval{{0, math.MaxInt64 - 1}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestSubtractMinEndpoint(t *testing.T) {
	got := Subtract(
		[]Interval{{math.MinInt64, 10}},
		[]Interval{{math.MinInt64, math.MinInt64}},
	)
	want := []Interval{{math.MinInt64 + 1, 10}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestSubtractEverything(t *testing.T) {
	got := Subtract(
		[]Interval{{math.MinInt64, math.MaxInt64}},
		[]Interval{{math.MinInt64, math.MaxInt64}},
	)
	if len(got) != 0 {
		t.Fatalf("got %v want empty", got)
	}
}

func TestSubtractSplitsInterval(t *testing.T) {
	got := Subtract(
		[]Interval{{math.MinInt64, math.MaxInt64}},
		[]Interval{{0, 0}},
	)
	want := []Interval{{math.MinInt64, -1}, {1, math.MaxInt64}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestSubtractMultipleCuts(t *testing.T) {
	got := Subtract(
		[]Interval{{0, 100}},
		[]Interval{{10, 20}, {30, 40}, {100, 200}},
	)
	want := []Interval{{0, 9}, {21, 29}, {41, 99}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestIntersectExtremes(t *testing.T) {
	got := Intersect(
		[]Interval{{math.MinInt64, 5}, {10, math.MaxInt64}},
		[]Interval{{0, 10}},
	)
	want := []Interval{{0, 5}, {10, 10}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestUnionMergesAcrossMany(t *testing.T) {
	got := Union(
		[]Interval{{0, 3}, {8, 10}},
		[]Interval{{4, 7}, {11, 12}},
	)
	want := []Interval{{0, 12}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestFormat(t *testing.T) {
	if got := Format([]Interval{{1, 2}, {5, 5}}); got != "[1,2] | [5,5]" {
		t.Fatalf("got %q", got)
	}
}
