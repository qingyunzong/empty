package partsum

import (
	"errors"
	"math"
	"math/big"
	"math/rand"
	"testing"
)

func resultByGroup(t *testing.T, results []GroupResult, group string) GroupResult {
	t.Helper()
	for _, r := range results {
		if r.Group == group {
			return r
		}
	}
	t.Fatalf("group %q missing from results %v", group, results)
	return GroupResult{}
}

// Intermediate partial sums may overflow int64 as long as later partitions
// cancel them back into range. A naive int64 accumulator would reject these.
func TestIntermediateOverflowCancels(t *testing.T) {
	cases := []struct {
		name       string
		partitions []Partition
		want       int64
	}{
		{
			name: "positive spike then cancel",
			partitions: []Partition{
				{Group: "g", Values: []int64{math.MaxInt64, math.MaxInt64}},
				{Group: "g", Values: []int64{-math.MaxInt64, -math.MaxInt64, 42}},
			},
			want: 42,
		},
		{
			name: "cancel arrives first",
			partitions: []Partition{
				{Group: "g", Values: []int64{-math.MaxInt64, -math.MaxInt64, 42}},
				{Group: "g", Values: []int64{math.MaxInt64, math.MaxInt64}},
			},
			want: 42,
		},
		{
			name: "negative spike below MinInt64",
			partitions: []Partition{
				{Group: "g", Values: []int64{math.MinInt64, -1}},
				{Group: "g", Values: []int64{1}},
			},
			want: math.MinInt64,
		},
		{
			name: "three-way seesaw",
			partitions: []Partition{
				{Group: "g", Values: []int64{math.MaxInt64}},
				{Group: "g", Values: []int64{math.MinInt64}},
				{Group: "g", Values: []int64{math.MaxInt64}},
				{Group: "g", Values: []int64{math.MinInt64}},
			},
			want: -2,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resultByGroup(t, Sum(tc.partitions), "g")
			if got.Err != nil {
				t.Fatalf("unexpected error: %v", got.Err)
			}
			if got.Sum != tc.want {
				t.Fatalf("sum = %d, want %d", got.Sum, tc.want)
			}
		})
	}
}

// Exactly MaxInt64 / MinInt64 are representable and must succeed.
func TestExactBoundaries(t *testing.T) {
	results := Sum([]Partition{
		{Group: "max", Values: []int64{math.MaxInt64 - 5, 5}},
		{Group: "min", Values: []int64{math.MinInt64 + 5, -5}},
	})
	if r := resultByGroup(t, results, "max"); r.Err != nil || r.Sum != math.MaxInt64 {
		t.Fatalf("max group = %+v, want sum %d", r, int64(math.MaxInt64))
	}
	if r := resultByGroup(t, results, "min"); r.Err != nil || r.Sum != math.MinInt64 {
		t.Fatalf("min group = %+v, want sum %d", r, int64(math.MinInt64))
	}
}

// A final out-of-range sum fails only its own group; sibling groups and the
// call as a whole still produce results.
func TestFinalOverflowIsPerGroup(t *testing.T) {
	results := Sum([]Partition{
		{Group: "ok", Values: []int64{1, 2, 3}},
		{Group: "over", Values: []int64{math.MaxInt64, 1}},
		{Group: "under", Values: []int64{math.MinInt64, -1}},
	})
	if len(results) != 3 {
		t.Fatalf("got %d results, want 3 (no whole-table failure)", len(results))
	}

	if r := resultByGroup(t, results, "ok"); r.Err != nil || r.Sum != 6 {
		t.Fatalf("ok group = %+v, want sum 6", r)
	}

	over := resultByGroup(t, results, "over")
	var overErr *OverflowError
	if !errors.As(over.Err, &overErr) {
		t.Fatalf("over group err = %v, want *OverflowError", over.Err)
	}
	wantOver := new(big.Int).Add(big.NewInt(math.MaxInt64), big.NewInt(1))
	if overErr.Sum.Cmp(wantOver) != 0 {
		t.Fatalf("over exact sum = %s, want %s", overErr.Sum, wantOver)
	}

	under := resultByGroup(t, results, "under")
	var underErr *OverflowError
	if !errors.As(under.Err, &underErr) {
		t.Fatalf("under group err = %v, want *OverflowError", under.Err)
	}
	wantUnder := new(big.Int).Sub(big.NewInt(math.MinInt64), big.NewInt(1))
	if underErr.Sum.Cmp(wantUnder) != 0 {
		t.Fatalf("under exact sum = %s, want %s", underErr.Sum, wantUnder)
	}
}

func TestEmptyInput(t *testing.T) {
	if got := Sum(nil); len(got) != 0 {
		t.Fatalf("Sum(nil) = %v, want empty", got)
	}
	got := resultByGroup(t, Sum([]Partition{{Group: "g"}}), "g")
	if got.Err != nil || got.Sum != 0 {
		t.Fatalf("empty partition = %+v, want sum 0", got)
	}
}

// referenceSum computes exact per-group sums independently of the library.
func referenceSum(partitions []Partition) map[string]*big.Int {
	totals := make(map[string]*big.Int)
	for _, p := range partitions {
		if _, ok := totals[p.Group]; !ok {
			totals[p.Group] = new(big.Int)
		}
		for _, v := range p.Values {
			totals[p.Group].Add(totals[p.Group], big.NewInt(v))
		}
	}
	return totals
}

func checkAgainstReference(t *testing.T, partitions []Partition) {
	t.Helper()
	want := referenceSum(partitions)
	results := Sum(partitions)
	if len(results) != len(want) {
		t.Fatalf("got %d group results, want %d", len(results), len(want))
	}
	for _, r := range results {
		ref, ok := want[r.Group]
		if !ok {
			t.Fatalf("unexpected group %q in results", r.Group)
		}
		if ref.IsInt64() {
			if r.Err != nil {
				t.Fatalf("group %q: unexpected error %v (exact sum %s fits int64)", r.Group, r.Err, ref)
			}
			if got := ref.Int64(); r.Sum != got {
				t.Fatalf("group %q: sum = %d, want %d", r.Group, r.Sum, got)
			}
		} else {
			var oe *OverflowError
			if !errors.As(r.Err, &oe) {
				t.Fatalf("group %q: err = %v, want *OverflowError (exact sum %s)", r.Group, r.Err, ref)
			}
			if oe.Sum.Cmp(ref) != 0 {
				t.Fatalf("group %q: exact sum = %s, want %s", r.Group, oe.Sum, ref)
			}
		}
	}
}

// Randomized property test: results must match an independent big.Int
// reference and must be invariant under random partition reordering.
func TestRandomizedAgainstBigIntReference(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	extremes := []int64{math.MaxInt64, math.MinInt64, math.MaxInt64 - 1, math.MinInt64 + 1, 0, 1, -1}

	for trial := 0; trial < 300; trial++ {
		groups := []string{"a", "b", "c", "d"}[:1+rng.Intn(4)]
		numPartitions := 1 + rng.Intn(12)
		partitions := make([]Partition, 0, numPartitions)
		for i := 0; i < numPartitions; i++ {
			values := make([]int64, rng.Intn(6))
			for j := range values {
				// Mix full-range random values with int64 extremes to force
				// frequent intermediate overflows that later cancel out.
				if rng.Intn(2) == 0 {
					values[j] = extremes[rng.Intn(len(extremes))]
				} else {
					values[j] = rng.Int63()
					if rng.Intn(2) == 0 {
						values[j] = -values[j] - 1
					}
				}
			}
			partitions = append(partitions, Partition{Group: groups[rng.Intn(len(groups))], Values: values})
		}

		checkAgainstReference(t, partitions)

		// Re-shuffle partition order several times; results must not change.
		for shuffle := 0; shuffle < 4; shuffle++ {
			shuffled := make([]Partition, len(partitions))
			copy(shuffled, partitions)
			rng.Shuffle(len(shuffled), func(i, j int) {
				shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
			})
			checkAgainstReference(t, shuffled)
		}
	}
}
