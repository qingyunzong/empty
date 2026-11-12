package dataeng

import (
	"errors"
	"math"
	"math/rand"
	"reflect"
	"testing"
)

func testHistogram(scale int, positive, negative Group, threshold Threshold) Histogram {
	var count uint64
	for _, c := range positive.Counts {
		count += c
	}
	for _, c := range negative.Counts {
		count += c
	}
	return Histogram{
		Scale:     scale,
		Positive:  positive,
		Negative:  negative,
		Threshold: threshold,
		Count:     count,
	}
}

func TestMergeEmptyInput(t *testing.T) {
	got, err := Merge(nil, 2)
	if err != nil {
		t.Fatal(err)
	}
	want := MergeResult{
		Scale:     MaxScale,
		Threshold: NewZeroThreshold(),
		Positive:  Group{},
		Negative:  Group{},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Merge(nil)=%+v, want %+v", got, want)
	}
}

func TestInputZeroCountsAreSummed(t *testing.T) {
	a := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{1}},
		Group{},
		NewZeroThreshold())
	a.ZeroCount = 2
	a.Count = 3
	b := testHistogram(0,
		Group{},
		Group{Offset: -1, Counts: []uint64{4}},
		NewZeroThreshold())
	b.ZeroCount = 5
	b.Count = 9

	got, err := Merge([]Histogram{a, b}, 2)
	if err != nil {
		t.Fatal(err)
	}
	want := MergeResult{
		Scale:     0,
		Threshold: NewZeroThreshold(),
		Positive:  Group{Offset: 0, Counts: []uint64{1}},
		Negative:  Group{Offset: -1, Counts: []uint64{4}},
		ZeroCount: 7,
		Count:     12,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("zero-count aggregation:\n got  %+v\n want %+v", got, want)
	}
}

func TestMergeDownscalesWithoutAssumingBucketDistribution(t *testing.T) {
	a := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{1, 2}},
		Group{Offset: -1, Counts: []uint64{3}},
		NewZeroThreshold())
	b := testHistogram(1,
		Group{Offset: 0, Counts: []uint64{4, 0, 6}},
		Group{Offset: -3, Counts: []uint64{5}},
		NewZeroThreshold(),
	)

	got, err := Merge([]Histogram{a, b}, 4096)
	if err != nil {
		t.Fatal(err)
	}
	want := MergeResult{
		Scale:     0,
		Threshold: NewZeroThreshold(),
		Positive:  Group{Offset: 0, Counts: []uint64{5, 8}},
		Negative:  Group{Offset: -2, Counts: []uint64{5, 3}},
		ZeroCount: 0,
		Count:     21,
	}
	// b's negative index -3 downscales to -2, while a's -1 stays at -1.

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Merge downscale:\n got  %+v\n want %+v", got, want)
	}
}

func TestNegativeIndicesMinusOneAndMinusTwoUseMathematicalFloor(t *testing.T) {
	h := testHistogram(0,
		Group{},
		Group{Offset: -2, Counts: []uint64{1, 1}},
		NewZeroThreshold())
	got, err := MergeAtScale([]Histogram{h}, -1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if got.Negative.Offset != -1 || len(got.Negative.Counts) != 1 ||
		got.Negative.Counts[0] != 2 {
		t.Fatalf("negative -1/-2 downscale: got %+v", got.Negative)
	}
	if got.Positive.Offset != 0 || len(got.Positive.Counts) != 0 {
		t.Fatalf("positive side should stay empty, got %+v", got.Positive)
	}
}

func TestNegativeSideAbsorptionAndOrientation(t *testing.T) {
	a := testHistogram(0,
		Group{},
		Group{Offset: -2, Counts: []uint64{1, 1}},
		NewZeroThreshold())
	b := testHistogram(0,
		Group{},
		Group{Offset: -1, Counts: []uint64{1}},
		Threshold{N: -1, K: 0}, // value 1/2
	)
	got, err := MergeAtScale([]Histogram{a, b}, -1, 2)
	if err != nil {
		t.Fatal(err)
	}
	want := MergeResult{
		Scale:     -1,
		Threshold: Threshold{N: 0, K: 0}, // raised to upper boundary 1
		Positive:  Group{},
		Negative:  Group{},
		ZeroCount: 3,
		Count:     3,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("negative absorption:\n got  %+v\n want %+v", got, want)
	}
}

func TestThresholdLowerEqualsNotAbsorbedUpperEqualsAbsorbed(t *testing.T) {
	lowerEqual := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{1}},
		Group{},
		Threshold{N: 0, K: 0}, // lower boundary is exactly 1
	)
	got, err := Merge([]Histogram{lowerEqual}, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if got.Positive.Offset != 0 || len(got.Positive.Counts) != 1 ||
		got.Positive.Counts[0] != 1 || got.ZeroCount != 0 {
		t.Fatalf("lower==T bucket must not be absorbed: %+v", got)
	}

	upperEqualA := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{1}},
		Group{},
		Threshold{N: 0, K: 0},
	)
	upperEqualB := testHistogram(0,
		Group{Offset: 1, Counts: []uint64{1}},
		Group{},
		Threshold{N: 1, K: 0}, // upper boundary of bucket 0 is exactly 2
	)
	got, err = Merge([]Histogram{upperEqualA, upperEqualB}, 4096)
	if err != nil {
		t.Fatal(err)
	}
	want := MergeResult{
		Scale:     0,
		Threshold: Threshold{N: 1, K: 0},
		Positive:  Group{Offset: 1, Counts: []uint64{1}},
		Negative:  Group{},
		ZeroCount: 1,
		Count:     2,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("upper==T bucket must be absorbed:\n got  %+v\n want %+v", got, want)
	}
}

func TestZeroThresholdNeverAbsorbsOrdinaryBuckets(t *testing.T) {
	h := testHistogram(0,
		Group{Offset: -3, Counts: []uint64{1, 0, 2}},
		Group{},
		NewZeroThreshold())
	got, err := Merge([]Histogram{h}, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if got.ZeroCount != 0 {
		t.Fatalf("zero threshold absorbed ordinary counts: %+v", got)
	}
	if !reflect.DeepEqual(got.Positive,
		Group{Offset: -3, Counts: []uint64{1, 0, 2}}) {
		t.Fatalf("ordinary buckets changed: %+v", got.Positive)
	}

	bothSides := testHistogram(0,
		Group{Offset: -1, Counts: []uint64{1}},
		Group{Offset: 0, Counts: []uint64{2}},
		NewZeroThreshold())
	got, err = Merge([]Histogram{bothSides}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if got.ZeroCount != 0 ||
		!reflect.DeepEqual(got.Positive, Group{Offset: -1, Counts: []uint64{1}}) ||
		!reflect.DeepEqual(got.Negative, Group{Offset: 0, Counts: []uint64{2}}) {
		t.Fatalf("buckets around literal zero threshold changed: %+v", got)
	}
}

func TestCrossingThresholdIsRaisedAndBucketAbsorbed(t *testing.T) {
	a := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{1}},
		Group{},
		NewZeroThreshold())
	b := testHistogram(0,
		Group{Offset: 1, Counts: []uint64{1}},
		Group{},
		Threshold{N: 1, K: 0}, // value 2
	)
	got, err := MergeAtScale([]Histogram{a, b}, -1, 2)
	if err != nil {
		t.Fatal(err)
	}
	want := MergeResult{
		Scale:     -1,
		Threshold: Threshold{N: 2, K: 0}, // raised to bucket upper 4
		Positive:  Group{},
		Negative:  Group{},
		ZeroCount: 2,
		Count:     2,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("crossing threshold:\n got  %+v\n want %+v", got, want)
	}
}

func TestInputThresholdAllowsZeroBucketCrossing(t *testing.T) {
	h := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{0, 1}},
		Group{},
		Threshold{N: 1, K: 0}, // zero-count bucket 0 spans (1,2]
	)
	got, err := Merge([]Histogram{h}, 4096)
	if err != nil {
		t.Fatal(err)
	}
	want := MergeResult{
		Scale:     0,
		Threshold: Threshold{N: 1, K: 0},
		Positive:  Group{Offset: 1, Counts: []uint64{1}},
		Negative:  Group{},
		Count:     1,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("zero bucket crossing threshold: got %+v want %+v", got, want)
	}
}

func TestInternalHoleIsPreservedOrLowerScaleNarrowsIt(t *testing.T) {
	h := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{1, 0, 0, 1}},
		Group{},
		NewZeroThreshold())

	got, err := Merge([]Histogram{h}, 4)
	if err != nil {
		t.Fatal(err)
	}
	if got.Scale != 0 || !reflect.DeepEqual(got.Positive,
		Group{Offset: 0, Counts: []uint64{1, 0, 0, 1}}) {
		t.Fatalf("internal hole at scale 0: %+v", got)
	}

	got, err = Merge([]Histogram{h}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if got.Scale != -1 || !reflect.DeepEqual(got.Positive,
		Group{Offset: 0, Counts: []uint64{1, 1}}) {
		t.Fatalf("internal hole after lower-scale fallback: %+v", got)
	}
}

func TestLargeInternalHoleIsRetained(t *testing.T) {
	counts := make([]uint64, 501)
	counts[0] = 1
	counts[500] = 2
	h := testHistogram(0,
		Group{Offset: 0, Counts: counts},
		Group{},
		NewZeroThreshold())
	got, err := Merge([]Histogram{h}, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if got.Scale != 0 || len(got.Positive.Counts) != 501 {
		t.Fatalf("large-hole result = %+v", got.Positive)
	}
	for i := 1; i < 500; i++ {
		if got.Positive.Counts[i] != 0 {
			t.Fatalf("large hole filled at position %d: %+v", i, got.Positive)
		}
	}
}

func TestCanonicalTrimmingKeepsInteriorZeros(t *testing.T) {
	h := testHistogram(0,
		Group{Offset: 5, Counts: []uint64{0, 1, 0, 0, 2, 0}},
		Group{},
		NewZeroThreshold())
	got, err := Merge([]Histogram{h}, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if got.Scale != 0 {
		t.Fatalf("scale = %d, want 0", got.Scale)
	}
	if !reflect.DeepEqual(got.Positive,
		Group{Offset: 6, Counts: []uint64{1, 0, 0, 2}}) {
		t.Fatalf("canonical group = %+v", got.Positive)
	}
}

func TestAllZeroSidesCanonicalizeToEmpty(t *testing.T) {
	h := testHistogram(0,
		Group{Offset: 7, Counts: []uint64{0, 0}},
		Group{Offset: -9, Counts: []uint64{0}},
		NewZeroThreshold())
	got, err := Merge([]Histogram{h}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if got.Scale != 0 || got.Positive.Offset != 0 || len(got.Positive.Counts) != 0 ||
		got.Negative.Offset != 0 || len(got.Negative.Counts) != 0 {
		t.Fatalf("all-zero result: %+v", got)
	}
}

func TestPermutationWithDifferentScalesAndThresholds(t *testing.T) {
	a := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{2}},
		Group{},
		Threshold{N: 0, K: 0}, // value 1
	)
	b := testHistogram(1,
		Group{Offset: 2, Counts: []uint64{1, 0, 4}},
		Group{},
		Threshold{N: 1, K: 0}, // value 2
	)
	c := testHistogram(-1,
		Group{},
		Group{Offset: -1, Counts: []uint64{3}},
		NewZeroThreshold(),
	)
	d := testHistogram(2,
		Group{},
		Group{Offset: 0, Counts: []uint64{5}},
		Threshold{N: 0, K: 0},
	)
	input := []Histogram{a, b, c, d}

	want, err := Merge(input, 4096)
	if err != nil {
		t.Fatal(err)
	}
	want = MergeResult{
		Scale:     -1,
		Threshold: Threshold{N: 2, K: 0},
		Positive:  Group{Offset: 1, Counts: []uint64{4}},
		Negative:  Group{},
		ZeroCount: 11,
		Count:     15,
	}

	permutations := [][]int{
		{3, 2, 1, 0},
		{1, 3, 0, 2},
		{2, 0, 3, 1},
		{1, 0, 3, 2},
	}
	for _, order := range permutations {
		var permuted []Histogram
		for _, index := range order {
			permuted = append(permuted, input[index])
		}
		got, err := Merge(permuted, 4096)
		if err != nil {
			t.Fatalf("order %v: %v", order, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("order %v:\n got  %+v\n want %+v", order, got, want)
		}
	}
}

func TestFixedScaleGroupedMergeMatchesSingleMerge(t *testing.T) {
	h1 := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{1}},
		Group{},
		NewZeroThreshold(),
	)
	h2 := testHistogram(0,
		Group{Offset: 1, Counts: []uint64{1}},
		Group{},
		Threshold{N: 1, K: 0}, // value 2
	)
	h3 := testHistogram(0,
		Group{},
		Group{Offset: -2, Counts: []uint64{1, 1}},
		NewZeroThreshold(),
	)

	want, err := CombineAtScale([]Histogram{h1, h2, h3}, -1)
	if err != nil {
		t.Fatal(err)
	}

	groupA, err := CombineAtScale([]Histogram{h1, h3}, -1)
	if err != nil {
		t.Fatal(err)
	}
	groupB, err := CombineAtScale([]Histogram{h2}, -1)
	if err != nil {
		t.Fatal(err)
	}
	got, err := CombineAtScale([]Histogram{groupA, groupB}, -1)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("fixed-scale grouping differs:\n got  %+v\n want %+v", got, want)
	}
}

func TestFixedScaleGroupingIsAssociativeOnRandomSmallInputs(t *testing.T) {
	rng := rand.New(rand.NewSource(304))
	for iteration := 0; iteration < 100; iteration++ {
		inputs := make([]Histogram, 0, 5)
		minScale := MaxScale
		count := 3 + rng.Intn(3)
		for i := 0; i < count; i++ {
			scale := -2 + rng.Intn(5)
			if scale < minScale {
				minScale = scale
			}
			threshold := NewZeroThreshold()
			offsetMin := -5
			if rng.Intn(2) == 0 {
				threshold = Threshold{N: 0, K: 0} // value 1
				offsetMin = 0
			}
			inputs = append(inputs, testHistogram(
				scale,
				randomTestGroup(rng, offsetMin, 6, 6),
				randomTestGroup(rng, offsetMin, 6, 6),
				threshold,
			))
		}

		target := minScale - rng.Intn(2)
		if target < MinScale {
			target = MinScale
		}
		want, err := CombineAtScale(inputs, target)
		if err != nil {
			t.Fatalf("iteration %d single combine: %v", iteration, err)
		}

		split := 1 + rng.Intn(len(inputs)-1)
		left, err := CombineAtScale(inputs[:split], target)
		if err != nil {
			t.Fatalf("iteration %d left combine: %v", iteration, err)
		}
		right, err := CombineAtScale(inputs[split:], target)
		if err != nil {
			t.Fatalf("iteration %d right combine: %v", iteration, err)
		}
		got, err := CombineAtScale([]Histogram{left, right}, target)
		if err != nil {
			t.Fatalf("iteration %d grouped combine: %v", iteration, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("iteration %d target %d grouping differs:\n groups %+v + %+v\n got  %+v\n want %+v",
				iteration, target, left, right, got, want)
		}
	}
}

func randomTestGroup(rng *rand.Rand, offsetMin, maxOffset, maxLength int) Group {
	if rng.Intn(5) == 0 {
		return Group{}
	}
	length := 1 + rng.Intn(maxLength)
	counts := make([]uint64, length)
	for i := range counts {
		if rng.Intn(3) == 0 {
			counts[i] = uint64(rng.Intn(6))
		}
	}
	return Group{
		Offset: int32(offsetMin + rng.Intn(maxOffset-offsetMin+1)),
		Counts: counts,
	}
}

func TestAdaptiveScaleIsNotGenerallyAssociative(t *testing.T) {
	a := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{1, 0, 0, 1}},
		Group{},
		NewZeroThreshold(),
	)
	b := testHistogram(0,
		Group{Offset: 2, Counts: []uint64{1}},
		Group{},
		Threshold{N: 1, K: 0}, // value 2
	)

	single, err := Merge([]Histogram{a, b}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if single.Scale != 0 || single.Threshold != (Threshold{N: 1, K: 0}) {
		t.Fatalf("single adaptive merge = %+v, want scale 0 threshold 2", single)
	}

	aGroup, err := Merge([]Histogram{a}, 2)
	if err != nil {
		t.Fatal(err)
	}
	bGroup, err := Merge([]Histogram{b}, 2)
	if err != nil {
		t.Fatal(err)
	}
	grouped, err := Merge([]Histogram{
		combineResultToHistogram(t, aGroup),
		combineResultToHistogram(t, bGroup),
	}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if reflect.DeepEqual(single, grouped) {
		t.Fatalf("expected adaptive grouping to differ, both are %+v", single)
	}
	if grouped.Scale != -1 || grouped.Threshold != (Threshold{N: 2, K: 0}) {
		t.Fatalf("grouped adaptive merge = %+v, want scale -1 threshold 4", grouped)
	}
}

func combineResultToHistogram(t *testing.T, r MergeResult) Histogram {
	t.Helper()
	return Histogram{
		Scale:     r.Scale,
		Threshold: r.Threshold,
		Positive:  r.Positive,
		Negative:  r.Negative,
		ZeroCount: r.ZeroCount,
		Count:     r.Count,
	}
}

func TestCapacityFailureAtMinusEightReportsBothSpans(t *testing.T) {
	counts := make([]uint64, 601)
	counts[0] = 1
	counts[300] = 1
	counts[600] = 1
	h := testHistogram(0,
		Group{Offset: 0, Counts: counts},
		Group{},
		NewZeroThreshold())

	got, err := Merge([]Histogram{h}, 2)
	if !errors.Is(err, ErrCapacity) {
		t.Fatalf("error = %v, want ErrCapacity", err)
	}
	var capacity *CapacityError
	if !errors.As(err, &capacity) {
		t.Fatalf("error type = %T, want *CapacityError", err)
	}
	if capacity.Scale != -8 || capacity.PositiveSpan != 3 ||
		capacity.NegativeSpan != 0 || capacity.MaxSpan != 2 {
		t.Fatalf("capacity detail = %+v", capacity)
	}
	if !reflect.DeepEqual(got, MergeResult{}) {
		t.Fatalf("capacity failure returned partial result: %+v", got)
	}
}

func TestHugeIndexGapCapacityDoesNotAllocateDenseArray(t *testing.T) {
	a := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{1}},
		Group{},
		NewZeroThreshold())
	b := testHistogram(0,
		Group{Offset: math.MaxInt32, Counts: []uint64{1}},
		Group{},
		NewZeroThreshold())
	got, err := Merge([]Histogram{a, b}, 2)
	if !errors.Is(err, ErrCapacity) {
		t.Fatalf("error = %v, want ErrCapacity", err)
	}
	var capacity *CapacityError
	if !errors.As(err, &capacity) {
		t.Fatalf("error type = %T", err)
	}
	if capacity.Scale != -8 || capacity.PositiveSpan != 8388608 ||
		capacity.NegativeSpan != 0 {
		t.Fatalf("capacity detail = %+v", capacity)
	}
	if !reflect.DeepEqual(got, MergeResult{}) {
		t.Fatalf("capacity failure returned partial result: %+v", got)
	}
}

func TestInvalidInputCountOverflowAndCapacityAreDistinct(t *testing.T) {
	makeOverflow := func() Histogram {
		return Histogram{
			Scale: 0,
			Positive: Group{Offset: 0, Counts: []uint64{
				math.MaxUint64, 1,
			}},
			Threshold: NewZeroThreshold(),
			Count:     0,
		}
	}
	if _, err := Merge([]Histogram{makeOverflow()}, 2); !errors.Is(err, ErrCountOverflow) {
		t.Fatalf("sum overflow error = %v, want ErrCountOverflow", err)
	}

	zeroPlusBucketOverflow := Histogram{
		Scale:     0,
		Positive:  Group{Offset: 0, Counts: []uint64{1}},
		Negative:  Group{},
		ZeroCount: math.MaxUint64,
		Threshold: NewZeroThreshold(),
		Count:     0,
	}
	if _, err := Merge([]Histogram{zeroPlusBucketOverflow}, 2); !errors.Is(err, ErrCountOverflow) {
		t.Fatalf("zero plus bucket overflow error = %v, want ErrCountOverflow", err)
	}

	mismatch := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{1}},
		Group{},
		NewZeroThreshold())
	mismatch.Count = 2
	if _, err := Merge([]Histogram{mismatch}, 2); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("count mismatch error = %v, want ErrInvalidInput", err)
	}

	a := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{math.MaxUint64}},
		Group{},
		NewZeroThreshold())
	b := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{1}},
		Group{},
		NewZeroThreshold())
	if _, err := Merge([]Histogram{a, b}, 2); !errors.Is(err, ErrCountOverflow) {
		t.Fatalf("aggregate count overflow error = %v, want ErrCountOverflow", err)
	}
}

func TestValidationRejectsBadOffsetsAndThresholdOverlap(t *testing.T) {
	emptyWithOffset := Histogram{
		Scale: 0, Positive: Group{Offset: 1}, Threshold: NewZeroThreshold(),
	}
	if err := ValidateHistogram(emptyWithOffset); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty offset error = %v", err)
	}

	tooWide := Histogram{
		Scale: 0,
		Positive: Group{
			Offset: math.MaxInt32,
			Counts: []uint64{1, 0},
		},
		Threshold: NewZeroThreshold(),
		Count:     1,
	}
	if err := ValidateHistogram(tooWide); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("offset range error = %v", err)
	}

	overlap := Histogram{
		Scale: 0,
		Positive: Group{
			Offset: 0,
			Counts: []uint64{1},
		},
		Threshold: Threshold{N: 1, K: 0}, // threshold 2; bucket lower is 1
		Count:     1,
	}
	if err := ValidateHistogram(overlap); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("threshold overlap error = %v", err)
	}
}

func TestInvalidScaleSpanAndUpscaleRequests(t *testing.T) {
	base := testHistogram(0, Group{}, Group{}, NewZeroThreshold())
	if _, err := Merge([]Histogram{base}, 1); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("maxSpan=1 error = %v", err)
	}
	if _, err := Merge([]Histogram{base}, 4097); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("maxSpan=4097 error = %v", err)
	}
	badScale := base
	badScale.Scale = 9
	if _, err := Merge([]Histogram{badScale}, 2); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("scale=9 error = %v", err)
	}
	badThreshold := base
	badThreshold.Threshold = NewThreshold(2, 17)
	if _, err := Merge([]Histogram{badThreshold}, 2); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("k=17 error = %v", err)
	}
	if _, err := MergeAtScale([]Histogram{base}, 1, 2); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("upscale request error = %v", err)
	}
}

func TestInputHistogramIsNotModified(t *testing.T) {
	h := testHistogram(0,
		Group{Offset: 0, Counts: []uint64{1, 0, 1}},
		Group{Offset: -2, Counts: []uint64{4}},
		NewZeroThreshold())
	before := Histogram{
		Scale:     h.Scale,
		Positive:  Group{Offset: h.Positive.Offset, Counts: append([]uint64(nil), h.Positive.Counts...)},
		Negative:  Group{Offset: h.Negative.Offset, Counts: append([]uint64(nil), h.Negative.Counts...)},
		ZeroCount: h.ZeroCount,
		Threshold: h.Threshold,
		Count:     h.Count,
	}
	if _, err := Merge([]Histogram{h}, 2); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(h, before) {
		t.Fatalf("input modified:\n got  %+v\n want %+v", h, before)
	}
}

func TestHugeThresholdDoesNotRequireFloatingPointEvaluation(t *testing.T) {
	h := Histogram{
		Scale:     8,
		Positive:  Group{Offset: 0, Counts: []uint64{0}},
		Negative:  Group{},
		Threshold: Threshold{N: math.MaxInt64, K: 16},
		Count:     0,
	}
	got, err := Merge([]Histogram{h}, 2)
	if err != nil {
		t.Fatal(err)
	}
	wantThreshold := canonicalizeThreshold(Threshold{N: math.MaxInt64, K: 16})
	if got.Scale != 8 || got.Threshold != wantThreshold ||
		got.ZeroCount != 0 || got.Count != 0 {
		t.Fatalf("huge threshold result = %+v, want threshold %+v",
			got, wantThreshold)
	}
}
