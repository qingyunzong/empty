package bucket

import (
	"math"
	"math/big"
	"math/rand"
	"testing"
)

// modelIndex is an independent arbitrary-precision reference for
// floor((t-origin)/width): it starts from truncated division (big.Int.Quo,
// which rounds toward zero like Go's /) and adjusts downward when the
// remainder is negative.
func modelIndex(t, origin, width int64) *big.Int {
	num := big.NewInt(t)
	num.Sub(num, big.NewInt(origin))
	w := big.NewInt(width)
	q, r := new(big.Int), new(big.Int)
	q.QuoRem(num, w, r) // truncated division
	if r.Sign() < 0 {
		q.Sub(q, big.NewInt(1))
	}
	return q
}

// modelCount counts events whose bucket span [origin+i*width,
// origin+(i+1)*width) lies entirely within [start, end), using only
// arbitrary-precision arithmetic.
func modelCount(events []int64, origin, width, start, end int64) int64 {
	var sum int64
	for _, t := range events {
		idx := modelIndex(t, origin, width)
		w := big.NewInt(width)
		lo := new(big.Int).Mul(idx, w)
		lo.Add(lo, big.NewInt(origin))
		hi := new(big.Int).Add(lo, w)
		if lo.Cmp(big.NewInt(start)) >= 0 && hi.Cmp(big.NewInt(end)) <= 0 {
			sum++
		}
	}
	return sum
}

var edgeValues = []int64{
	math.MinInt64, math.MinInt64 + 1, math.MinInt64 + 2,
	-1 << 32, -100, -7, -2, -1, 0, 1, 2, 7, 100, 1 << 32,
	math.MaxInt64 - 2, math.MaxInt64 - 1, math.MaxInt64,
}

func TestBucketIndexAgainstModel(t *testing.T) {
	widths := []int64{1, 2, 3, 5, 10, 1 << 20, 1 << 32, math.MaxInt64}
	for _, width := range widths {
		for _, origin := range edgeValues {
			for _, ts := range edgeValues {
				got := bucketIndex(ts, origin, width)
				want := modelIndex(ts, origin, width)
				if got.Cmp(want) != 0 {
					t.Errorf("bucketIndex(%d, %d, %d) = %s, model = %s",
						ts, origin, width, got, want)
				}
			}
		}
	}
}

func TestBucketIndexNegativeTime(t *testing.T) {
	cases := []struct {
		t, origin, width int64
		want             string
	}{
		{t: -1, origin: 0, width: 10, want: "-1"},  // floor(-1/10) = -1, not 0
		{t: -10, origin: 0, width: 10, want: "-1"}, // boundary lands exactly
		{t: -11, origin: 0, width: 10, want: "-2"},
		{t: -6, origin: -10, width: 5, want: "0"},   // floor(4/5)
		{t: -11, origin: -10, width: 5, want: "-1"}, // floor(-1/5)
		{t: 0, origin: 1, width: 3, want: "-1"},     // negative origin offset
		{t: math.MinInt64, origin: math.MaxInt64, width: 1, want: "-18446744073709551615"},
		{t: math.MaxInt64, origin: math.MinInt64, width: 1, want: "18446744073709551615"},
	}
	for _, c := range cases {
		got := bucketIndex(c.t, c.origin, c.width)
		if got.String() != c.want {
			t.Errorf("bucketIndex(%d, %d, %d) = %s, want %s",
				c.t, c.origin, c.width, got, c.want)
		}
		if want := modelIndex(c.t, c.origin, c.width); got.Cmp(want) != 0 {
			t.Errorf("bucketIndex(%d, %d, %d) = %s, model = %s",
				c.t, c.origin, c.width, got, want)
		}
	}
}

func TestCountFullyContainedOnly(t *testing.T) {
	a, err := New(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	// bucket 0: [0,10), bucket 1: [10,20), bucket 2: [20,30)
	for _, ts := range []int64{0, 5, 10, 15, 20} {
		a.Add(ts)
	}
	cases := []struct {
		start, end int64
		want       int64
	}{
		{0, 30, 5},   // all three buckets fully inside
		{0, 20, 4},   // buckets 0 and 1
		{1, 20, 2},   // bucket 0 starts before the range: excluded
		{0, 19, 2},   // bucket 1 ends after the range: excluded
		{-5, 25, 4},  // buckets 0 and 1; bucket 2 sticks out
		{10, 20, 2},  // exactly bucket 1
		{5, 15, 0},   // no bucket fully inside
		{20, 10, 0},  // empty/inverted range
		{10, 10, 0},  // degenerate range
		{-100, 0, 0}, // range covers only empty buckets
	}
	for _, c := range cases {
		if got := a.Count(c.start, c.end); got != c.want {
			t.Errorf("Count(%d, %d) = %d, want %d", c.start, c.end, got, c.want)
		}
	}
}

func TestCountNegativeOrigin(t *testing.T) {
	a, err := New(5, -10)
	if err != nil {
		t.Fatal(err)
	}
	// bucket -1: [-15,-10), bucket 0: [-10,-5), bucket 1: [-5,0)
	for _, ts := range []int64{-14, -11, -10, -6, -5, -1} {
		a.Add(ts)
	}
	if got := a.Count(-15, 0); got != 6 {
		t.Errorf("Count(-15, 0) = %d, want 6", got)
	}
	if got := a.Count(-10, 0); got != 4 {
		t.Errorf("Count(-10, 0) = %d, want 4", got)
	}
	if got := a.Count(-14, -1); got != 2 {
		// Only bucket 0 ([-10,-5)) is fully inside [-14,-1).
		t.Errorf("Count(-14, -1) = %d, want 2", got)
	}
}

func TestGenerationIsolation(t *testing.T) {
	a, err := New(10, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, ts := range []int64{0, 5, 12} { // gen 0, origin 0
		a.Add(ts)
	}
	before := a.Count(-100, 100)

	gen1 := a.SetOrigin(7) // new generation, origin 7
	if gen1 != 1 || a.Generation() != 1 {
		t.Fatalf("Generation() = %d, want 1", a.Generation())
	}
	for _, ts := range []int64{7, 8, 25} { // gen 1 buckets: [7,17), [17,27)
		a.Add(ts)
	}

	// Old generation is unpolluted by the origin change and new events.
	if got := a.CountGeneration0(t, 0, -100, 100); got != before {
		t.Errorf("gen 0 count changed from %d to %d after SetOrigin", before, got)
	}
	if got := a.CountGeneration0(t, 0, 0, 20); got != 3 {
		t.Errorf("gen 0 Count(0,20) = %d, want 3", got)
	}
	// New generation indexes by the new origin: t=7 -> bucket 0, t=25 -> bucket 1.
	if got := a.Count(7, 27); got != 3 {
		t.Errorf("gen 1 Count(7,27) = %d, want 3", got)
	}
	if got := a.Count(0, 20); got != 2 { // bucket [7,17) fully inside, [17,27) not
		t.Errorf("gen 1 Count(0,20) = %d, want 2", got)
	}
	if got := a.Total(); got != 3 {
		t.Errorf("gen 1 Total() = %d, want 3", got)
	}
	// Origin of each generation is preserved.
	if o, _ := a.Origin(0); o != 0 {
		t.Errorf("Origin(0) = %d, want 0", o)
	}
	if o, _ := a.Origin(1); o != 7 {
		t.Errorf("Origin(1) = %d, want 7", o)
	}
}

func (a *Aggregator) CountGeneration0(t *testing.T, gen int, start, end int64) int64 {
	t.Helper()
	n, err := a.CountGeneration(gen, start, end)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestExtremesAgainstModel(t *testing.T) {
	origins := []int64{math.MinInt64, -1, 0, 1, math.MaxInt64}
	widths := []int64{1, 3, 1 << 40, math.MaxInt64}
	events := []int64{math.MinInt64, math.MinInt64 + 1, -1, 0, 1, math.MaxInt64 - 1, math.MaxInt64}
	ranges := [][2]int64{
		{math.MinInt64, math.MaxInt64},
		{math.MinInt64, 0},
		{0, math.MaxInt64},
		{-1, 1},
		{math.MaxInt64 - 1, math.MaxInt64},
	}
	for _, origin := range origins {
		for _, width := range widths {
			a, err := New(width, origin)
			if err != nil {
				t.Fatal(err)
			}
			for _, ts := range events {
				a.Add(ts)
			}
			for _, r := range ranges {
				got := a.Count(r[0], r[1])
				want := modelCount(events, origin, width, r[0], r[1])
				if got != want {
					t.Errorf("origin=%d width=%d Count(%d,%d) = %d, model = %d",
						origin, width, r[0], r[1], got, want)
				}
			}
		}
	}
}

func TestRandomizedAgainstModel(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 200; trial++ {
		width := 1 + rng.Int63n(1<<30)
		origin := int64(rng.Uint64())
		a, err := New(width, origin)
		if err != nil {
			t.Fatal(err)
		}
		events := make([]int64, 50)
		for i := range events {
			events[i] = int64(rng.Uint64())
		}
		for _, ts := range events {
			a.Add(ts)
		}
		start := int64(rng.Uint64())
		end := int64(rng.Uint64())
		if start > end {
			start, end = end, start
		}
		got := a.Count(start, end)
		want := modelCount(events, origin, width, start, end)
		if got != want {
			t.Fatalf("trial %d: origin=%d width=%d Count(%d,%d) = %d, model = %d",
				trial, origin, width, start, end, got, want)
		}
	}
}

func TestInvalidWidth(t *testing.T) {
	for _, width := range []int64{0, -1, math.MinInt64} {
		if _, err := New(width, 0); err != ErrInvalidWidth {
			t.Errorf("New(%d, 0) err = %v, want ErrInvalidWidth", width, err)
		}
	}
	if _, err := a().CountGeneration(99, 0, 1); err == nil {
		t.Error("CountGeneration with bad generation: want error")
	}
}

func a() *Aggregator {
	agg, _ := New(1, 0)
	return agg
}
