package reference_test

import (
	"math/rand"
	"reflect"
	"testing"

	"example.org/dataeng/q0304"
	"example.org/dataeng/q0304/reference"
)

func histogram(scale int, positive, negative dataeng.Group, threshold dataeng.Threshold) dataeng.Histogram {
	var count uint64
	for _, c := range positive.Counts {
		count += c
	}
	for _, c := range negative.Counts {
		count += c
	}
	return dataeng.Histogram{
		Scale:     scale,
		Positive:  positive,
		Negative:  negative,
		Threshold: threshold,
		Count:     count,
	}
}

func TestReferenceMatchesFixedScaleClosure(t *testing.T) {
	inputs := []dataeng.Histogram{
		histogram(0,
			dataeng.Group{Offset: 0, Counts: []uint64{1}},
			dataeng.Group{},
			dataeng.NewZeroThreshold()),
		histogram(0,
			dataeng.Group{Offset: 1, Counts: []uint64{1}},
			dataeng.Group{},
			dataeng.Threshold{N: 1, K: 0}),
		histogram(0,
			dataeng.Group{},
			dataeng.Group{Offset: -2, Counts: []uint64{1, 1}},
			dataeng.NewZeroThreshold()),
	}
	got, err := dataeng.CombineAtScale(inputs, -1)
	if err != nil {
		t.Fatal(err)
	}
	want, err := reference.MergeAtScale(inputs, -1)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("fixed-scale reference mismatch:\n got  %+v\n want %+v", got, want)
	}
}

func TestReferenceMatchesDifferentScalesThresholdsAndNegativeIndexes(t *testing.T) {
	inputs := []dataeng.Histogram{
		histogram(0,
			dataeng.Group{Offset: 0, Counts: []uint64{2}},
			dataeng.Group{},
			dataeng.Threshold{N: 0, K: 0}),
		histogram(1,
			dataeng.Group{Offset: 2, Counts: []uint64{1, 0, 4}},
			dataeng.Group{},
			dataeng.Threshold{N: 1, K: 0}),
		histogram(-1,
			dataeng.Group{},
			dataeng.Group{Offset: -1, Counts: []uint64{3}},
			dataeng.NewZeroThreshold()),
		histogram(2,
			dataeng.Group{},
			dataeng.Group{Offset: 0, Counts: []uint64{5}},
			dataeng.Threshold{N: 0, K: 0}),
	}
	got, err := dataeng.CombineAtScale(inputs, -1)
	if err != nil {
		t.Fatal(err)
	}
	want, err := reference.MergeAtScale(inputs, -1)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("reference mismatch:\n got  %+v\n want %+v", got, want)
	}
}

func TestReferenceMatchesRandomSmallExpansions(t *testing.T) {
	rng := rand.New(rand.NewSource(304))
	for iteration := 0; iteration < 100; iteration++ {
		n := 1 + rng.Intn(5)
		inputs := make([]dataeng.Histogram, 0, n)
		minScale := dataeng.MaxScale
		for i := 0; i < n; i++ {
			scale := -3 + rng.Intn(7)
			if scale < minScale {
				minScale = scale
			}
			positive := randomGroup(rng)
			negative := randomGroup(rng)
			inputs = append(inputs, histogram(
				scale, positive, negative, dataeng.NewZeroThreshold()))
		}
		scale := minScale - rng.Intn(3)
		if scale < dataeng.MinScale {
			scale = dataeng.MinScale
		}

		got, err := dataeng.CombineAtScale(inputs, scale)
		if err != nil {
			t.Fatalf("iteration %d production: %v", iteration, err)
		}
		want, err := reference.MergeAtScale(inputs, scale)
		if err != nil {
			t.Fatalf("iteration %d reference: %v", iteration, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("iteration %d scale %d mismatch:\n got  %+v\n want %+v",
				iteration, scale, got, want)
		}
	}
}

func randomGroup(rng *rand.Rand) dataeng.Group {
	if rng.Intn(4) == 0 {
		return dataeng.Group{}
	}
	length := 1 + rng.Intn(9)
	counts := make([]uint64, length)
	for i := range counts {
		if rng.Intn(3) == 0 {
			counts[i] = uint64(rng.Intn(8))
		}
	}
	return dataeng.Group{
		Offset: int32(rng.Intn(41) - 20),
		Counts: counts,
	}
}
