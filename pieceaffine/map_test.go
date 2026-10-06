package pieceaffine

import "testing"

// testMaps covers positive, negative (orientation-flipping) and zero
// coefficients, non-unit divisors and multi-piece domains.
func testMaps(t *testing.T) []Map {
	t.Helper()
	d := Interval{Lo: -8, Hi: 9}
	return []Map{
		mustMap(t, d, Piece{Dom: d, A: 1, B: 0, C: 1}),
		mustMap(t, d, Piece{Dom: d, A: 2, B: 1, C: 3}),
		mustMap(t, d, Piece{Dom: d, A: -1, B: 0, C: 2}),
		mustMap(t, d, Piece{Dom: d, A: -3, B: 5, C: 2}),
		mustMap(t, d, Piece{Dom: d, A: 0, B: 7, C: 3}),
		mustMap(t, d, Piece{Dom: d, A: 0, B: -4, C: 5}),
		mustMap(t, d,
			Piece{Dom: Interval{Lo: -8, Hi: -3}, A: -1, B: 0, C: 1},
			Piece{Dom: Interval{Lo: -3, Hi: 2}, A: 2, B: -1, C: 3},
			Piece{Dom: Interval{Lo: 2, Hi: 9}, A: 0, B: 4, C: 1}),
		mustMap(t, d,
			Piece{Dom: Interval{Lo: -8, Hi: 0}, A: 3, B: 2, C: 4},
			Piece{Dom: Interval{Lo: 0, Hi: 9}, A: -3, B: 2, C: 4}),
	}
}

func testOutputs() []Interval {
	return []Interval{
		{Lo: -3, Hi: -1}, {Lo: -2, Hi: 3}, {Lo: 0, Hi: 1},
		{Lo: 5, Hi: 9}, {Lo: -10, Hi: -7}, {Lo: 2, Hi: 2}, {Lo: -1, Hi: 0},
	}
}

// TestPreimageBruteForce checks every map/output pair value-by-value
// against the reference enumerator, which pins down endpoint inclusion
// and orientation flips exactly.
func TestPreimageBruteForce(t *testing.T) {
	for _, m := range testMaps(t) {
		for _, y := range testOutputs() {
			got := m.Preimage(y)
			want := bruteMapPreimage(m, y)
			if !equalIntervals(got, want) {
				t.Errorf("Map(%+v).Preimage(%v) = %v, want %v", m.Pieces, y, got, want)
			}
		}
	}
}

// TestPreimageSetBruteForce checks multi-interval output sets.
func TestPreimageSetBruteForce(t *testing.T) {
	for _, m := range testMaps(t) {
		ys := []Interval{{Lo: -3, Hi: -1}, {Lo: 0, Hi: 2}, {Lo: 4, Hi: 4}}
		got := m.PreimageSet(ys)
		var want []Interval
		for _, y := range ys {
			want = append(want, bruteMapPreimage(m, y)...)
		}
		want = Canonical(want)
		if !equalIntervals(got, want) {
			t.Errorf("Map(%+v).PreimageSet(%v) = %v, want %v", m.Pieces, ys, got, want)
		}
	}
}

func TestNewMapValidation(t *testing.T) {
	d := Interval{Lo: 0, Hi: 4}
	if _, err := NewMap(Interval{Lo: 2, Hi: 2}, Piece{Dom: Interval{Lo: 2, Hi: 2}, A: 1, C: 1}); err == nil {
		t.Error("empty domain accepted")
	}
	if _, err := NewMap(d, Piece{Dom: d, A: 1, C: 0}); err == nil {
		t.Error("zero divisor accepted")
	}
	if _, err := NewMap(d, Piece{Dom: Interval{Lo: 0, Hi: 2}, A: 1, C: 1}); err == nil {
		t.Error("incomplete cover accepted")
	}
	if _, err := NewMap(d,
		Piece{Dom: Interval{Lo: 0, Hi: 3}, A: 1, C: 1},
		Piece{Dom: Interval{Lo: 2, Hi: 4}, A: 1, C: 1}); err == nil {
		t.Error("overlapping pieces accepted")
	}
	if _, err := NewMap(d,
		Piece{Dom: Interval{Lo: 0, Hi: 1}, A: 1, C: 1},
		Piece{Dom: Interval{Lo: 2, Hi: 4}, A: 1, C: 1}); err == nil {
		t.Error("gap between pieces accepted")
	}
}

func TestEval(t *testing.T) {
	m := mustMap(t, Interval{Lo: -4, Hi: 4}, Piece{Dom: Interval{Lo: -4, Hi: 4}, A: -1, B: 1, C: 2})
	// f(x) = floor((1 - x) / 2)
	cases := map[int64]int64{-4: 2, -3: 2, -2: 1, -1: 1, 0: 0, 1: 0, 2: -1, 3: -1}
	for x, want := range cases {
		got, ok := m.Eval(x)
		if !ok || got != want {
			t.Errorf("Eval(%d) = %d, %v; want %d, true", x, got, ok, want)
		}
	}
	if _, ok := m.Eval(4); ok {
		t.Error("Eval(4) outside half-open domain reported ok")
	}
}
