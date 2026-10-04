package statmatch

import (
	"math/big"
	"math/rand"
	"testing"
)

func rat(n, d int64) *big.Rat { return big.NewRat(n, d) }

func pairIDs(pairs []Pair) [][2]string {
	out := make([][2]string, len(pairs))
	for i, p := range pairs {
		out[i] = [2]string{p.A.ID, p.B.ID}
	}
	return out
}

func equalIDs(a, b [][2]string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Minimum-difference matching must not be simplified to joining equal
// timestamps: here an equal-time join would pair only a1~b1, while the
// minimum-difference rule also pairs a2~b2 (difference 1/10).
func TestMatchMinDiffNotEqualTime(t *testing.T) {
	a := []Point{{"a1", rat(0, 1), 1}, {"a2", rat(2, 1), 2}}
	b := []Point{{"b1", rat(0, 1), 3}, {"b2", rat(19, 10), 4}}
	pairs := Match(a, b, rat(5, 1))
	want := [][2]string{{"a1", "b1"}, {"a2", "b2"}}
	if !equalIDs(pairIDs(pairs), want) {
		t.Fatalf("got %v, want %v", pairIDs(pairs), want)
	}
	if pairs[1].Diff.Cmp(rat(1, 10)) != 0 {
		t.Fatalf("a2~b2 diff = %s, want 1/10", pairs[1].Diff)
	}
}

// Equal time differences are resolved by ID order.
func TestMatchTieByID(t *testing.T) {
	a := []Point{{"a2", rat(0, 1), 1}, {"a1", rat(0, 1), 2}}
	b := []Point{{"b2", rat(0, 1), 3}, {"b1", rat(0, 1), 4}}
	pairs := Match(a, b, rat(0, 1))
	want := [][2]string{{"a1", "b1"}, {"a2", "b2"}}
	if !equalIDs(pairIDs(pairs), want) {
		t.Fatalf("got %v, want %v", pairIDs(pairs), want)
	}
}

// The maximum gap is rational: a difference exactly equal to the gap is
// admitted, anything larger is not.
func TestMatchRationalGapBoundary(t *testing.T) {
	a := []Point{{"a1", rat(0, 1), 1}, {"a2", rat(1, 3), 2}}
	b := []Point{{"b1", rat(1, 6), 3}, {"b2", rat(5, 6), 4}}
	// |a1-b1| = 1/6, |a2-b2| = 1/2 == gap (admitted), others exceed 1/2.
	pairs := Match(a, b, rat(1, 2))
	want := [][2]string{{"a1", "b1"}, {"a2", "b2"}}
	if !equalIDs(pairIDs(pairs), want) {
		t.Fatalf("got %v, want %v", pairIDs(pairs), want)
	}
	// With a gap of 1/3 the a2~b2 pair must disappear.
	pairs = Match(a, b, rat(1, 3))
	want = [][2]string{{"a1", "b1"}}
	if !equalIDs(pairIDs(pairs), want) {
		t.Fatalf("got %v, want %v", pairIDs(pairs), want)
	}
}

func TestMatchEnumerationFixed(t *testing.T) {
	a := []Point{
		{"a1", rat(0, 1), 1}, {"a2", rat(3, 2), 2}, {"a3", rat(5, 2), 3},
	}
	b := []Point{
		{"b1", rat(1, 2), 4}, {"b2", rat(2, 1), 5}, {"b3", rat(3, 1), 6},
	}
	got := Match(a, b, rat(1, 1))
	if err := VerifyMatchingByEnumeration(a, b, rat(1, 1), got); err != nil {
		t.Fatal(err)
	}
}

// Randomized cross-check of the greedy matching against independent
// enumeration of all one-to-one matchings.
func TestMatchEnumerationRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for iter := 0; iter < 300; iter++ {
		a := randomPoints(rng, "a", rng.Intn(8))
		b := randomPoints(rng, "b", rng.Intn(8))
		gap := rat(int64(rng.Intn(6)), int64(1+rng.Intn(3)))
		got := Match(a, b, gap)
		if err := VerifyMatchingByEnumeration(a, b, gap, got); err != nil {
			t.Fatalf("iter %d: %v\na=%v\nb=%v\ngap=%s", iter, err, a, b, gap)
		}
	}
}

func randomPoints(rng *rand.Rand, prefix string, n int) []Point {
	ps := make([]Point, n)
	for i := range ps {
		ps[i] = Point{
			ID: prefix + string(rune('0'+i)),
			T:  rat(int64(rng.Intn(13)), int64(1+rng.Intn(4))),
			V:  int64(rng.Intn(21) - 10),
		}
	}
	return ps
}
