package agg

import (
	"math"
	"math/big"
	"math/rand"
	"testing"
)

// modelFloorDiv is the independent arbitrary-precision reference model:
// Euclidean division (big.Int.Div), which for a positive divisor is exactly
// floor division toward negative infinity.
func modelFloorDiv(t, origin, width int64) *big.Int {
	num := new(big.Int).Sub(big.NewInt(t), big.NewInt(origin))
	return new(big.Int).Div(num, big.NewInt(width))
}

// checkFloorInvariant verifies the defining floor property in big.Int:
// q*width <= t-origin < (q+1)*width.
func checkFloorInvariant(t *testing.T, ts, origin, width int64, q *big.Int) {
	t.Helper()
	num := new(big.Int).Sub(big.NewInt(ts), big.NewInt(origin))
	w := big.NewInt(width)
	lo := new(big.Int).Mul(new(big.Int).Set(q), w)
	hi := new(big.Int).Add(lo, w)
	if lo.Cmp(num) > 0 || hi.Cmp(num) <= 0 {
		t.Fatalf("floor invariant broken: t=%d origin=%d width=%d q=%s num=%s span=[%s,%s)",
			ts, origin, width, q, num, lo, hi)
	}
}

func TestBucketIndexNegativeTimes(t *testing.T) {
	a, err := New(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		ts   int64
		want int64
	}{
		{0, 0}, {9, 0}, {10, 1}, {19, 1},
		{-1, -1}, {-9, -1}, {-10, -1}, {-11, -2}, {-20, -2}, {-21, -3},
	}
	for _, c := range cases {
		got, err := a.BucketIndex(0, c.ts)
		if err != nil {
			t.Fatal(err)
		}
		if got.Cmp(big.NewInt(c.want)) != 0 {
			t.Errorf("t=%d: got %s, want %d", c.ts, got, c.want)
		}
		checkFloorInvariant(t, c.ts, 0, 10, got)
		if model := modelFloorDiv(c.ts, 0, 10); got.Cmp(model) != 0 {
			t.Errorf("t=%d: got %s, model %s", c.ts, got, model)
		}
	}
}

func TestBucketIndexNegativeOrigin(t *testing.T) {
	a, err := New(10, -5)
	if err != nil {
		t.Fatal(err)
	}
	// Buckets: [-15,-5)=-1, [-5,5)=0, [5,15)=1, ...
	cases := []struct {
		ts   int64
		want int64
	}{
		{-5, 0}, {0, 0}, {4, 0}, {5, 1}, {14, 1}, {15, 2},
		{-6, -1}, {-14, -1}, {-15, -1}, {-16, -2},
	}
	for _, c := range cases {
		got, err := a.BucketIndex(0, c.ts)
		if err != nil {
			t.Fatal(err)
		}
		if got.Cmp(big.NewInt(c.want)) != 0 {
			t.Errorf("t=%d: got %s, want %d", c.ts, got, c.want)
		}
		checkFloorInvariant(t, c.ts, -5, 10, got)
		if model := modelFloorDiv(c.ts, -5, 10); got.Cmp(model) != 0 {
			t.Errorf("t=%d: got %s, model %s", c.ts, got, model)
		}
	}
}

func TestBucketIndexExtremes(t *testing.T) {
	origins := []int64{0, -5, math.MinInt64, math.MaxInt64, math.MinInt64 + 1}
	times := []int64{math.MinInt64, math.MinInt64 + 1, -1, 0, 1, math.MaxInt64 - 1, math.MaxInt64}
	widths := []int64{1, 3, 10, math.MaxInt64, math.MaxInt64 - 1}
	for _, origin := range origins {
		a, err := New(1, origin) // width replaced per-iteration below via new aggregator
		if err != nil {
			t.Fatal(err)
		}
		for _, width := range widths {
			aw, err := New(width, origin)
			if err != nil {
				t.Fatal(err)
			}
			_ = a
			for _, ts := range times {
				got, err := aw.BucketIndex(0, ts)
				if err != nil {
					t.Fatal(err)
				}
				checkFloorInvariant(t, ts, origin, width, got)
				if model := modelFloorDiv(ts, origin, width); got.Cmp(model) != 0 {
					t.Errorf("t=%d origin=%d width=%d: got %s, model %s",
						ts, origin, width, got, model)
				}
			}
		}
	}
}

func TestBucketIndexPropertyRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for i := 0; i < 20000; i++ {
		ts := int64(rng.Uint64())
		origin := int64(rng.Uint64())
		width := int64(rng.Uint64()%1_000_000) + 1
		a, err := New(width, origin)
		if err != nil {
			t.Fatal(err)
		}
		got, err := a.BucketIndex(0, ts)
		if err != nil {
			t.Fatal(err)
		}
		checkFloorInvariant(t, ts, origin, width, got)
		if model := modelFloorDiv(ts, origin, width); got.Cmp(model) != 0 {
			t.Fatalf("t=%d origin=%d width=%d: got %s, model %s",
				ts, origin, width, got, model)
		}
	}
}

func TestQueryFullyContainedOnly(t *testing.T) {
	// width 10, origin 0: buckets [0,10), [10,20), [20,30), ...
	a, err := New(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, ts := range []int64{0, 5, 9, 10, 15, 20, 25, 29, 30} {
		a.Add(ts)
	}
	cases := []struct {
		start, end int64
		want       int64
	}{
		{0, 30, 8},     // buckets 0,1,2 fully inside; t=30 excluded (end-exclusive)
		{0, 31, 8},     // bucket 3 ([30,40)) still not fully inside
		{1, 29, 2},     // only bucket [10,20) fully inside: t=10,15
		{10, 30, 5},    // buckets [10,20),[20,30): t=10,15,20,25,29
		{-10, 40, 9},   // all buckets fully inside
		{5, 25, 2},     // bucket [10,20) fully inside: t=10,15
		{10, 20, 2},    // bucket [10,20): t=10,15
		{0, 10, 3},     // bucket [0,10): t=0,5,9
		{-100, 100, 9}, // everything
	}
	for _, c := range cases {
		got, err := a.QueryCurrent(c.start, c.end)
		if err != nil {
			t.Fatal(err)
		}
		if got != c.want {
			t.Errorf("range [%d,%d): got %d, want %d", c.start, c.end, got, c.want)
		}
	}
}

func TestQueryNegativeOriginAndTimes(t *testing.T) {
	// width 10, origin -5: buckets [-15,-5)=-1, [-5,5)=0, [5,15)=1
	a, err := New(10, -5)
	if err != nil {
		t.Fatal(err)
	}
	for _, ts := range []int64{-15, -10, -6, -5, 0, 4, 5, 14} {
		a.Add(ts)
	}
	got, err := a.QueryCurrent(-15, 15)
	if err != nil {
		t.Fatal(err)
	}
	if got != 8 {
		t.Errorf("got %d, want 8", got)
	}
	got, err = a.QueryCurrent(-5, 5)
	if err != nil {
		t.Fatal(err)
	}
	if got != 3 { // bucket [-5,5): t=-5,0,4
		t.Errorf("got %d, want 3", got)
	}
	got, err = a.QueryCurrent(-14, 15)
	if err != nil {
		t.Fatal(err)
	}
	if got != 5 { // buckets [-5,5) and [5,15): t=-5,0,4,5,14
		t.Errorf("got %d, want 5", got)
	}
}

func TestGenerationsIsolated(t *testing.T) {
	a, err := New(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Generation 0, origin 0: events at 0, 12.
	a.Add(0)
	a.Add(12)
	before, err := a.Query(0, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if before != 2 {
		t.Fatalf("gen0 before re-origin: got %d, want 2", before)
	}

	// Re-origin: generation 1 with origin -5.
	gen1 := a.SetOrigin(-5)
	if gen1 != 1 || a.Generations() != 2 {
		t.Fatalf("gen1=%d generations=%d", gen1, a.Generations())
	}
	// Same timestamps now land in different buckets of the new generation.
	a.Add(0)  // bucket 0 of gen1 ([-5,5))
	a.Add(12) // bucket 1 of gen1 ([5,15))

	// Old generation must be unpolluted.
	after, err := a.Query(0, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Errorf("gen0 polluted: before=%d after=%d", before, after)
	}
	// Old generation still holds exactly its own two events.
	total0, err := a.Query(0, math.MinInt64, math.MaxInt64)
	if err != nil {
		t.Fatal(err)
	}
	if total0 != 2 {
		t.Errorf("gen0 total: got %d, want 2", total0)
	}
	// New generation queries reflect the new origin.
	got1, err := a.Query(1, -5, 15)
	if err != nil {
		t.Fatal(err)
	}
	if got1 != 2 {
		t.Errorf("gen1 [-5,15): got %d, want 2", got1)
	}
	got1, err = a.Query(1, 0, 20)
	if err != nil {
		t.Fatal(err)
	}
	if got1 != 1 { // only bucket [5,15) fully inside: t=12
		t.Errorf("gen1 [0,20): got %d, want 1", got1)
	}
	// Origin of each generation is preserved.
	if o, _ := a.Origin(0); o != 0 {
		t.Errorf("gen0 origin: got %d, want 0", o)
	}
	if o, _ := a.Origin(1); o != -5 {
		t.Errorf("gen1 origin: got %d, want -5", o)
	}
}

func TestQueryExtremeTimestamps(t *testing.T) {
	// Negative origin near MinInt64, events at int64 extremes.
	a, err := New(math.MaxInt64, math.MinInt64)
	if err != nil {
		t.Fatal(err)
	}
	a.Add(math.MinInt64)     // bucket 0: [MinInt64, -1)
	a.Add(math.MinInt64 + 1) // bucket 0
	a.Add(-1)                // bucket 1 (bucket 0 hi = -1 is exclusive)
	a.Add(0)                 // bucket 1: [-1, MaxInt64-1)
	a.Add(math.MaxInt64)     // bucket 2
	got, err := a.QueryCurrent(math.MinInt64, -1)
	if err != nil {
		t.Fatal(err)
	}
	if got != 2 {
		t.Errorf("bucket0: got %d, want 2", got)
	}
	got, err = a.QueryCurrent(math.MinInt64, math.MaxInt64)
	if err != nil {
		t.Fatal(err)
	}
	if got != 4 { // buckets 0 and 1 fully inside; bucket 2 straddles the end
		t.Errorf("got %d, want 4", got)
	}
}

func TestInvalidWidthAndGeneration(t *testing.T) {
	if _, err := New(0, 0); err != ErrInvalidWidth {
		t.Errorf("width 0: got %v, want ErrInvalidWidth", err)
	}
	if _, err := New(-3, 0); err != ErrInvalidWidth {
		t.Errorf("width -3: got %v, want ErrInvalidWidth", err)
	}
	a, err := New(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.Query(7, 0, 10); err != ErrNoGeneration {
		t.Errorf("query gen 7: got %v, want ErrNoGeneration", err)
	}
	if _, err := a.BucketIndex(-1, 0); err != ErrNoGeneration {
		t.Errorf("index gen -1: got %v, want ErrNoGeneration", err)
	}
	if err := a.AddTo(3, 0); err != ErrNoGeneration {
		t.Errorf("add gen 3: got %v, want ErrNoGeneration", err)
	}
}
