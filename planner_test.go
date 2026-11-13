package dataeng

import (
	"errors"
	"math"
	"math/rand"
	"slices"
	"testing"
)

func TestPlanUniform(t *testing.T) {
	samples := make([]Sample[int], 0, 6)
	for key := 1; key <= 6; key++ {
		samples = append(samples, Sample[int]{Key: key, Weight: 1})
	}

	plan, err := PlanSamples(samples, 60, 3)
	if err != nil {
		t.Fatalf("PlanSamples: %v", err)
	}
	if got, want := plan.Boundaries, []int{2, 4}; !slices.Equal(got, want) {
		t.Fatalf("Boundaries = %v, want %v", got, want)
	}
	if plan.MaxLoad != 20 {
		t.Fatalf("MaxLoad = %v, want 20", plan.MaxLoad)
	}
	if plan.TotalLoad != 60 {
		t.Fatalf("TotalLoad = %v, want 60", plan.TotalLoad)
	}
	for i, partition := range plan.Partitions {
		if partition.Empty || partition.Keys != 2 || partition.Load != 20 {
			t.Fatalf("Partitions[%d] = %+v, want 2 keys and load 20", i, partition)
		}
	}
}

func TestPlanDedicatedHeavyKeyAcrossShards(t *testing.T) {
	shards := []Shard[string]{
		{Name: "a", Samples: []Sample[string]{
			{Key: "apple", Weight: 5},
			{Key: "hot", Weight: 60},
		}},
		{Name: "b", Samples: []Sample[string]{
			{Key: "hot", Weight: 40},
			{Key: "zebra", Weight: 5},
		}},
	}

	plan, err := Plan(shards, 110, 3)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if got, want := plan.Boundaries, []string{"apple", "hot"}; !slices.Equal(got, want) {
		t.Fatalf("Boundaries = %v, want %v", got, want)
	}
	if got, want := plan.DistinctKeys, 3; got != want {
		t.Fatalf("DistinctKeys = %d, want %d", got, want)
	}
	if got, want := plan.Partitions[1].Lower, "hot"; got != want {
		t.Fatalf("heavy partition lower = %q, want %q", got, want)
	}
	if got, want := plan.Partitions[1].Upper, "hot"; got != want {
		t.Fatalf("heavy partition upper = %q, want %q", got, want)
	}
	if got, want := plan.Partitions[1].Load, 100.0; got != want {
		t.Fatalf("heavy partition load = %v, want %v", got, want)
	}
	if got, want := plan.MaxLoad, 100.0; got != want {
		t.Fatalf("MaxLoad = %v, want %v", got, want)
	}
}

func TestPlanScalesToTotalRows(t *testing.T) {
	plan, err := PlanSamples([]Sample[int]{
		{Key: 1, Weight: 1},
		{Key: 2, Weight: 3},
		{Key: 3, Weight: 2},
	}, 6000, 1)
	if err != nil {
		t.Fatalf("PlanSamples: %v", err)
	}
	if plan.TotalLoad != 6000 {
		t.Fatalf("TotalLoad = %v, want 6000", plan.TotalLoad)
	}
	if plan.MaxLoad != 6000 {
		t.Fatalf("MaxLoad = %v, want 6000", plan.MaxLoad)
	}
	if got, want := plan.Partitions[0].Load, 6000.0; got != want {
		t.Fatalf("partition load = %v, want %v", got, want)
	}
}

func TestPlanMorePartitionsThanKeys(t *testing.T) {
	plan, err := PlanSamples([]Sample[int]{
		{Key: 10, Weight: 4},
		{Key: 20, Weight: 7},
	}, 11, 4)
	if err != nil {
		t.Fatalf("PlanSamples: %v", err)
	}
	if got, want := plan.Boundaries, []int{10, 20, 20}; !slices.Equal(got, want) {
		t.Fatalf("Boundaries = %v, want %v", got, want)
	}
	if len(plan.Partitions) != 4 {
		t.Fatalf("len(Partitions) = %d, want 4", len(plan.Partitions))
	}
	if plan.Partitions[0].Empty || plan.Partitions[1].Empty {
		t.Fatalf("first two partitions should be non-empty: %+v", plan.Partitions[:2])
	}
	if !plan.Partitions[2].Empty || !plan.Partitions[3].Empty {
		t.Fatalf("trailing partitions should be empty: %+v", plan.Partitions[2:])
	}
	if plan.MaxLoad != 7 {
		t.Fatalf("MaxLoad = %v, want 7", plan.MaxLoad)
	}
}

func TestPlanSinglePartition(t *testing.T) {
	plan, err := PlanSamples([]Sample[int]{
		{Key: 1, Weight: 2},
		{Key: 2, Weight: 5},
	}, 7, 1)
	if err != nil {
		t.Fatalf("PlanSamples: %v", err)
	}
	if len(plan.Boundaries) != 0 {
		t.Fatalf("Boundaries = %v, want empty", plan.Boundaries)
	}
	if plan.Partitions[0].Lower != 1 || plan.Partitions[0].Upper != 2 {
		t.Fatalf("partition bounds = %v..%v, want 1..2", plan.Partitions[0].Lower, plan.Partitions[0].Upper)
	}
	if plan.MaxLoad != 7 || plan.Partitions[0].Load != 7 {
		t.Fatalf("load = %v, max = %v, want 7", plan.Partitions[0].Load, plan.MaxLoad)
	}
}

func TestLexicographicTieBreak(t *testing.T) {
	plan, err := PlanSamples([]Sample[int]{
		{Key: 1, Weight: 3},
		{Key: 2, Weight: 3},
		{Key: 3, Weight: 3},
	}, 9, 2)
	if err != nil {
		t.Fatalf("PlanSamples: %v", err)
	}

	// Both cuts give a maximum load of 6. The smaller first boundary wins.
	if got, want := plan.Boundaries, []int{1}; !slices.Equal(got, want) {
		t.Fatalf("Boundaries = %v, want %v", got, want)
	}
	if got, want := plan.Partitions[0].Load, 3.0; got != want {
		t.Fatalf("first load = %v, want %v", got, want)
	}
	if got, want := plan.Partitions[1].Load, 6.0; got != want {
		t.Fatalf("second load = %v, want %v", got, want)
	}

	exhaustive, err := PlanExhaustive([]Sample[int]{
		{Key: 1, Weight: 3},
		{Key: 2, Weight: 3},
		{Key: 3, Weight: 3},
	}, 9, 2)
	if err != nil {
		t.Fatalf("PlanExhaustive: %v", err)
	}
	if !slices.Equal(exhaustive.Boundaries, plan.Boundaries) {
		t.Fatalf("exhaustive boundaries = %v, Plan boundaries = %v", exhaustive.Boundaries, plan.Boundaries)
	}
}

func TestPlanIsIndependentOfInputOrder(t *testing.T) {
	shards := []ShardSamples[int]{
		{Name: "a", Samples: []Sample[int]{
			{Key: 1, Weight: 2},
			{Key: 4, Weight: 8},
			{Key: 7, Weight: 1},
		}},
		{Name: "b", Samples: []Sample[int]{
			{Key: 2, Weight: 5},
			{Key: 4, Weight: 3},
			{Key: 9, Weight: 2},
		}},
		{Name: "c", Samples: []Sample[int]{
			{Key: 3, Weight: 4},
			{Key: 8, Weight: 2},
		}},
	}
	want, err := Plan(shards, 1000, 4)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}

	rng := rand.New(rand.NewSource(42))
	for iteration := 0; iteration < 20; iteration++ {
		shuffled := append([]ShardSamples[int](nil), shards...)
		rng.Shuffle(len(shuffled), func(i, j int) {
			shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
		})
		for i := range shuffled {
			samples := append([]Sample[int](nil), shuffled[i].Samples...)
			rng.Shuffle(len(samples), func(a, b int) {
				samples[a], samples[b] = samples[b], samples[a]
			})
			shuffled[i].Samples = samples
		}

		got, err := Plan(shuffled, 1000, 4)
		if err != nil {
			t.Fatalf("Plan after shuffle: %v", err)
		}
		if !slices.Equal(got.Boundaries, want.Boundaries) ||
			got.MaxLoad != want.MaxLoad ||
			!slices.Equal(got.Partitions, want.Partitions) {
			t.Fatalf("shuffle %d changed plan:\ngot  %+v\nwant %+v", iteration, got, want)
		}
	}
}

func TestZeroWeightSamplesAreIgnored(t *testing.T) {
	plan, err := PlanSamples([]Sample[int]{
		{Key: 1, Weight: 0},
		{Key: 2, Weight: 5},
	}, 5, 1)
	if err != nil {
		t.Fatalf("PlanSamples: %v", err)
	}
	if plan.DistinctKeys != 1 {
		t.Fatalf("DistinctKeys = %d, want 1", plan.DistinctKeys)
	}
	if plan.Partitions[0].Lower != 2 || plan.Partitions[0].Upper != 2 {
		t.Fatalf("partition bounds = %v..%v, want 2..2", plan.Partitions[0].Lower, plan.Partitions[0].Upper)
	}
}

func TestZeroRowsStillProducesDistributionBoundaries(t *testing.T) {
	plan, err := PlanSamples([]Sample[int]{
		{Key: 1, Weight: 1},
		{Key: 2, Weight: 1},
		{Key: 3, Weight: 1},
		{Key: 4, Weight: 1},
	}, 0, 2)
	if err != nil {
		t.Fatalf("PlanSamples: %v", err)
	}
	if got, want := plan.Boundaries, []int{2}; !slices.Equal(got, want) {
		t.Fatalf("Boundaries = %v, want %v", got, want)
	}
	if plan.MaxLoad != 0 || plan.TotalLoad != 0 {
		t.Fatalf("loads = %v/%v, want 0/0", plan.MaxLoad, plan.TotalLoad)
	}
}

func TestValidation(t *testing.T) {
	tests := []struct {
		name    string
		samples []Sample[float64]
		rows    int64
		parts   int
		wantErr error
	}{
		{
			name:    "zero partitions",
			samples: []Sample[float64]{{Key: 1, Weight: 1}},
			rows:    1,
			parts:   0,
			wantErr: ErrInvalidArgument,
		},
		{
			name:    "negative rows",
			samples: []Sample[float64]{{Key: 1, Weight: 1}},
			rows:    -1,
			parts:   1,
			wantErr: ErrInvalidArgument,
		},
		{
			name:    "negative weight",
			samples: []Sample[float64]{{Key: 1, Weight: -1}},
			rows:    1,
			parts:   1,
			wantErr: ErrInvalidArgument,
		},
		{
			name:    "NaN weight",
			samples: []Sample[float64]{{Key: 1, Weight: math.NaN()}},
			rows:    1,
			parts:   1,
			wantErr: ErrInvalidArgument,
		},
		{
			name:    "infinite weight",
			samples: []Sample[float64]{{Key: 1, Weight: math.Inf(1)}},
			rows:    1,
			parts:   1,
			wantErr: ErrInvalidArgument,
		},
		{
			name:    "NaN key",
			samples: []Sample[float64]{{Key: math.NaN(), Weight: 1}},
			rows:    1,
			parts:   1,
			wantErr: ErrInvalidArgument,
		},
		{
			name:    "positive rows without samples",
			samples: nil,
			rows:    1,
			parts:   1,
			wantErr: ErrNoSamples,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := PlanSamples(test.samples, test.rows, test.parts)
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("error = %v, want %v", err, test.wantErr)
			}
		})
	}
}

func TestEmptyPlanForZeroRowsAndNoSamples(t *testing.T) {
	plan, err := PlanSamples[int](nil, 0, 3)
	if err != nil {
		t.Fatalf("PlanSamples: %v", err)
	}
	if len(plan.Partitions) != 3 {
		t.Fatalf("len(Partitions) = %d, want 3", len(plan.Partitions))
	}
	for i, partition := range plan.Partitions {
		if !partition.Empty {
			t.Fatalf("Partitions[%d] is not empty: %+v", i, partition)
		}
	}
	if len(plan.Boundaries) != 0 {
		t.Fatalf("Boundaries = %v, want empty", plan.Boundaries)
	}
}

func TestBoundariesAreTotallyOrdered(t *testing.T) {
	samples := []Sample[string]{
		{Key: "a", Weight: 1},
		{Key: "b", Weight: 4},
		{Key: "c", Weight: 1},
		{Key: "d", Weight: 2},
	}
	for partitions := 1; partitions <= 6; partitions++ {
		plan, err := PlanSamples(samples, 8, partitions)
		if err != nil {
			t.Fatalf("partitions=%d: %v", partitions, err)
		}
		if len(plan.Boundaries) != partitions-1 {
			t.Fatalf("partitions=%d: len(Boundaries) = %d, want %d", partitions, len(plan.Boundaries), partitions-1)
		}
		for i := 1; i < len(plan.Boundaries); i++ {
			if plan.Boundaries[i] < plan.Boundaries[i-1] {
				t.Fatalf("partitions=%d: boundaries not ordered: %v", partitions, plan.Boundaries)
			}
		}
		for i := 0; i+1 < len(plan.Boundaries); i++ {
			if plan.Partitions[i].Empty || plan.Partitions[i+1].Empty {
				continue
			}
			if plan.Boundaries[i] >= plan.Boundaries[i+1] {
				t.Fatalf("partitions=%d: non-empty ranges do not have strict boundaries: %v", partitions, plan.Boundaries)
			}
		}
	}
}

func TestFractionalWeights(t *testing.T) {
	plan, err := PlanSamples([]Sample[int]{
		{Key: 1, Weight: 0.5},
		{Key: 2, Weight: 0.25},
		{Key: 3, Weight: 0.25},
	}, 100, 2)
	if err != nil {
		t.Fatalf("PlanSamples: %v", err)
	}
	if got, want := plan.Boundaries, []int{1}; !slices.Equal(got, want) {
		t.Fatalf("Boundaries = %v, want %v", got, want)
	}
	if math.Abs(plan.MaxLoad-50) > 1e-9 {
		t.Fatalf("MaxLoad = %v, want 50", plan.MaxLoad)
	}
}

func TestBinarySearchMatchesExhaustive(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	for iteration := 0; iteration < 1000; iteration++ {
		keyCount := 1 + rng.Intn(14)
		weights := make([]float64, keyCount)
		for i := range weights {
			weights[i] = float64(rng.Intn(21))
		}
		partitions := 1 + rng.Intn(keyCount)

		got := binarySearchEnds(weights, partitions)
		want := exhaustiveEnds(weights, partitions)

		if len(got) != partitions {
			t.Fatalf("iteration %d: len(binary ends) = %d, want %d (weights=%v)", iteration, len(got), partitions, weights)
		}
		if last := got[len(got)-1]; last != keyCount {
			t.Fatalf("iteration %d: last end = %d, want %d", iteration, last, keyCount)
		}

		gotMax := maxLoadForEnds(weights, got)
		wantMax := maxLoadForEnds(weights, want)
		if math.Abs(gotMax-wantMax) > 1e-9 {
			t.Fatalf("iteration %d: binary max = %v, exhaustive max = %v (weights=%v, p=%d)",
				iteration, gotMax, wantMax, weights, partitions)
		}
	}
}

func TestBinarySearchTieBreakMatchesExhaustive(t *testing.T) {
	rng := rand.New(rand.NewSource(17))
	for iteration := 0; iteration < 2000; iteration++ {
		keyCount := 2 + rng.Intn(11)
		weights := make([]float64, keyCount)
		for i := range weights {
			weights[i] = float64(rng.Intn(11))
		}
		partitions := 2 + rng.Intn(keyCount-1)

		got := binarySearchEnds(weights, partitions)
		want := exhaustiveEnds(weights, partitions)
		if !slices.Equal(got, want) {
			t.Fatalf("iteration %d: binary ends = %v, exhaustive ends = %v (weights=%v, p=%d)",
				iteration, got, want, weights, partitions)
		}
	}
}

func TestBinarySearchFractionalTieBreakMatchesExhaustive(t *testing.T) {
	rng := rand.New(rand.NewSource(23))
	for iteration := 0; iteration < 2000; iteration++ {
		keyCount := 2 + rng.Intn(9)
		weights := make([]float64, keyCount)
		for i := range weights {
			weights[i] = float64(rng.Intn(1000)) / 7
		}
		partitions := 2 + rng.Intn(keyCount-1)

		got := binarySearchEnds(weights, partitions)
		want := exhaustiveEnds(weights, partitions)
		if !slices.Equal(got, want) {
			t.Fatalf("iteration %d: binary ends = %v, exhaustive ends = %v (weights=%v, p=%d)",
				iteration, got, want, weights, partitions)
		}
	}
}

func TestBinarySearchMatchesDynamicProgramming(t *testing.T) {
	rng := rand.New(rand.NewSource(31))
	for iteration := 0; iteration < 300; iteration++ {
		keyCount := 1 + rng.Intn(40)
		weights := make([]float64, keyCount)
		for i := range weights {
			weights[i] = float64(rng.Intn(1000)) / 13
		}
		partitions := 1 + rng.Intn(keyCount)

		got := maxLoadForEnds(weights, binarySearchEnds(weights, partitions))
		want := dpOptimalMaxLoad(weights, partitions)
		if math.Abs(got-want) > 1e-9*math.Max(1, want) {
			t.Fatalf("iteration %d: binary max = %v, DP max = %v (weights=%v, p=%d)",
				iteration, got, want, weights, partitions)
		}
	}
}

func TestPlanExhaustiveMatchesPlanSamples(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	for iteration := 0; iteration < 300; iteration++ {
		keyCount := 1 + rng.Intn(9)
		weights := make([]float64, keyCount)
		samples := make([]Sample[int], keyCount)
		for i := range weights {
			weights[i] = float64(rng.Intn(11))
			samples[i] = Sample[int]{Key: i * 3, Weight: weights[i]}
		}
		partitions := 1 + rng.Intn(keyCount+2)
		rows := int64(rng.Intn(1000))
		totalWeight := 0.0
		for _, weight := range weights {
			totalWeight += weight
		}
		if totalWeight == 0 {
			rows = 0
		}

		plan, err := PlanSamples(samples, rows, partitions)
		if err != nil {
			t.Fatalf("PlanSamples: %v", err)
		}
		exhaustive, err := PlanExhaustive(samples, rows, partitions)
		if err != nil {
			t.Fatalf("PlanExhaustive: %v", err)
		}
		if !slices.Equal(plan.Boundaries, exhaustive.Boundaries) {
			t.Fatalf("iteration %d: boundaries differ: %v vs %v", iteration, plan.Boundaries, exhaustive.Boundaries)
		}
		if math.Abs(plan.MaxLoad-exhaustive.MaxLoad) > 1e-9 {
			t.Fatalf("iteration %d: max loads differ: %v vs %v", iteration, plan.MaxLoad, exhaustive.MaxLoad)
		}
	}
}

func TestPlanExhaustiveRejectsTooManyCombinations(t *testing.T) {
	samples := make([]Sample[int], 40)
	for i := range samples {
		samples[i] = Sample[int]{Key: i, Weight: 1}
	}
	_, err := PlanExhaustive(samples, 40, 20)
	if !errors.Is(err, ErrExhaustiveTooLarge) {
		t.Fatalf("error = %v, want %v", err, ErrExhaustiveTooLarge)
	}
}

func maxLoadForEnds(weights []float64, ends []int) float64 {
	start := 0
	maxLoad := 0.0
	for _, end := range ends {
		load := 0.0
		for i := start; i < end; i++ {
			load += weights[i]
		}
		if load > maxLoad {
			maxLoad = load
		}
		start = end
	}
	return maxLoad
}

func dpOptimalMaxLoad(weights []float64, partitions int) float64 {
	keyCount := len(weights)
	prefix := make([]float64, keyCount+1)
	for i, weight := range weights {
		prefix[i+1] = prefix[i] + weight
	}

	previous := make([]float64, keyCount+1)
	current := make([]float64, keyCount+1)
	for i := 1; i <= keyCount; i++ {
		previous[i] = math.Inf(1)
	}
	for group := 1; group <= partitions; group++ {
		for i := 0; i <= keyCount; i++ {
			current[i] = math.Inf(1)
		}
		for end := group; end <= keyCount; end++ {
			for cut := group - 1; cut < end; cut++ {
				load := prefix[end] - prefix[cut]
				candidate := math.Max(previous[cut], load)
				if candidate < current[end] {
					current[end] = candidate
				}
			}
		}
		previous, current = current, previous
	}
	return previous[keyCount]
}
