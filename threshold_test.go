package dataeng

import (
	"math"
	"testing"
)

func TestExactRationalExponentComparisons(t *testing.T) {
	tests := []struct {
		name   string
		scale  int
		index  int64
		thresh Threshold
		want   int
	}{
		{
			name:   "equal_positive_rational",
			scale:  1,
			index:  3,
			thresh: Threshold{N: 3, K: 1},
			want:   0,
		},
		{
			name:   "equal_uncanonical_rational",
			scale:  2,
			index:  6,
			thresh: Threshold{N: 3, K: 1},
			want:   0,
		},
		{
			name:   "lower_boundary_below",
			scale:  1,
			index:  2,
			thresh: Threshold{N: 3, K: 1},
			want:   -1,
		},
		{
			name:   "upper_boundary_above",
			scale:  1,
			index:  4,
			thresh: Threshold{N: 3, K: 1},
			want:   1,
		},
		{
			name:   "equal_negative_exponent",
			scale:  -1,
			index:  -1,
			thresh: Threshold{N: -2, K: 0},
			want:   0,
		},
		{
			name:   "equal_half_negative",
			scale:  1,
			index:  -1,
			thresh: Threshold{N: -1, K: 1},
			want:   0,
		},
		{
			name:   "huge_threshold_is_greater",
			scale:  8,
			index:  math.MaxInt32,
			thresh: Threshold{N: math.MaxInt64, K: 0},
			want:   -1,
		},
		{
			name:   "tiny_threshold_is_less",
			scale:  8,
			index:  math.MinInt32,
			thresh: Threshold{N: math.MinInt64, K: 0},
			want:   1,
		},
		{
			name:   "zero_threshold_below_every_boundary",
			scale:  -8,
			index:  math.MinInt32,
			thresh: NewZeroThreshold(),
			want:   1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := compareBoundaryToThreshold(tc.scale, tc.index, tc.thresh); got != tc.want {
				t.Fatalf("compareBoundaryToThreshold(%d,%d,%+v)=%d, want %d",
					tc.scale, tc.index, tc.thresh, got, tc.want)
			}
		})
	}
}

func TestExponentCrossMultiplicationAcrossDenominators(t *testing.T) {
	if got := compareExponents(exponent{n: -3, d: 1}, exponent{n: -6, d: 2}); got != 0 {
		t.Fatalf("negative rational equality comparison = %d, want 0", got)
	}
	if got := compareExponents(exponent{n: math.MaxInt64, d: 0}, exponent{n: 1, d: 16}); got <= 0 {
		t.Fatalf("large exact comparison = %d, want positive", got)
	}
}

func TestThresholdCanonicalization(t *testing.T) {
	tests := []struct {
		in   Threshold
		want Threshold
	}{
		{in: Threshold{N: 2, K: 1}, want: Threshold{N: 1, K: 0}},
		{in: Threshold{N: -2, K: 1}, want: Threshold{N: -1, K: 0}},
		{in: Threshold{N: 0, K: 2}, want: Threshold{N: 0, K: 0}},
		{in: Threshold{N: 4, K: 2}, want: Threshold{N: 1, K: 0}},
		{in: Threshold{N: 3, K: 1}, want: Threshold{N: 3, K: 1}},
		{in: NewZeroThreshold(), want: NewZeroThreshold()},
	}
	for _, tc := range tests {
		if got := canonicalizeThreshold(tc.in); got != tc.want {
			t.Fatalf("canonicalizeThreshold(%+v)=%+v, want %+v", tc.in, got, tc.want)
		}
	}
}

func TestMergeReturnsCanonicalThreshold(t *testing.T) {
	h := Histogram{
		Scale:     0,
		Positive:  Group{Offset: 0, Counts: []uint64{0}},
		Negative:  Group{},
		Threshold: Threshold{N: 2, K: 1}, // value 2, canonical 2^1/2^0
		Count:     0,
	}
	got, err := Merge([]Histogram{h}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if got.Threshold != (Threshold{N: 1, K: 0}) {
		t.Fatalf("noncanonical threshold result = %+v", got.Threshold)
	}
}

func TestThresholdFromBucketBoundary(t *testing.T) {
	tests := []struct {
		scale int
		index int64
		want  Threshold
	}{
		{scale: -1, index: 1, want: Threshold{N: 2, K: 0}},
		{scale: 1, index: 3, want: Threshold{N: 3, K: 1}},
		{scale: 2, index: 2, want: Threshold{N: 1, K: 1}},
	}
	for _, tc := range tests {
		if got := thresholdFromBoundary(tc.scale, tc.index); got != tc.want {
			t.Fatalf("thresholdFromBoundary(%d,%d)=%+v, want %+v",
				tc.scale, tc.index, got, tc.want)
		}
	}
}
