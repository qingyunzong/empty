package preimage

import (
	"math/rand"
	"reflect"
	"testing"
)

func TestCanonicalize(t *testing.T) {
	in := []Interval{
		{Lo: 5, Hi: 8},
		{Lo: 0, Hi: 2},
		{Lo: 2, Hi: 3},   // adjacent to [0,2): merges
		{Lo: 6, Hi: 10},  // overlaps [5,8)
		{Lo: -4, Hi: -4}, // empty, dropped
		{Lo: 20, Hi: 15}, // empty, dropped
	}
	want := []Interval{{Lo: 0, Hi: 3}, {Lo: 5, Hi: 10}}
	if got := Canonicalize(in); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestNewMapValidation(t *testing.T) {
	if _, err := NewMap(nil); err == nil {
		t.Fatal("expected error for no pieces")
	}
	gap := []Piece{
		{Dom: Interval{Lo: 0, Hi: 4}, F: NewAffine(1, 0, 1)},
		{Dom: Interval{Lo: 6, Hi: 9}, F: NewAffine(1, 0, 1)},
	}
	if _, err := NewMap(gap); err == nil {
		t.Fatal("expected error for gap")
	}
	overlap := []Piece{
		{Dom: Interval{Lo: 0, Hi: 5}, F: NewAffine(1, 0, 1)},
		{Dom: Interval{Lo: 4, Hi: 9}, F: NewAffine(1, 0, 1)},
	}
	if _, err := NewMap(overlap); err == nil {
		t.Fatal("expected error for overlap")
	}
}

// bruteMapPreimage is the value-by-value reference over a short domain.
func bruteMapPreimage(m Map, y Interval) []Interval {
	var out []Interval
	dom := m.Domain()
	for x := dom.Lo; x < dom.Hi; x++ {
		if v, ok := m.Eval(x); ok && y.Contains(v) {
			out = append(out, Interval{Lo: x, Hi: x + 1})
		}
	}
	return Canonicalize(out)
}

func randMap(rng *rand.Rand, lo, hi int64, maxPieces int) Map {
	n := 1 + rng.Intn(maxPieces)
	width := (hi - lo) / int64(n)
	var pieces []Piece
	cursor := lo
	for i := 0; i < n; i++ {
		end := cursor + width
		if i == n-1 {
			end = hi
		}
		pieces = append(pieces, Piece{
			Dom: Interval{Lo: cursor, Hi: end},
			F:   NewAffine(rng.Int63n(11)-5, rng.Int63n(21)-10, rng.Int63n(5)+1),
		})
		cursor = end
	}
	m, err := NewMap(pieces)
	if err != nil {
		panic(err)
	}
	return m
}

func TestMapPreimageAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(3))
	for i := 0; i < 500; i++ {
		m := randMap(rng, -40, 40, 4)
		y := Interval{Lo: rng.Int63n(31) - 15, Hi: 0}
		y.Hi = y.Lo + rng.Int63n(10) + 1
		got := m.Preimage(y)
		want := bruteMapPreimage(m, y)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("pieces=%v y=%v:\ngot  %v\nwant %v", m.Pieces(), y, got, want)
		}
	}
}

func TestMapEvalOutsideDomain(t *testing.T) {
	m, err := NewMap([]Piece{{Dom: Interval{Lo: 2, Hi: 7}, F: NewAffine(1, 0, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Eval(2); !ok {
		t.Fatal("lower bound must be included (half-open domain)")
	}
	if _, ok := m.Eval(7); ok {
		t.Fatal("upper bound must be excluded (half-open domain)")
	}
	if _, ok := m.Eval(-1); ok {
		t.Fatal("outside domain must report false")
	}
}
