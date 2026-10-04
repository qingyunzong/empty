package tsfill

import (
	"math/big"
	"math/rand"
	"testing"
)

func rat(n, d int64) *big.Rat { return big.NewRat(n, d) }

func pointsToMap(t *testing.T, pts []Point) map[int64]*big.Rat {
	t.Helper()
	m := make(map[int64]*big.Rat, len(pts))
	for _, p := range pts {
		if _, dup := m[p.Index]; dup {
			t.Fatalf("duplicate emitted index %d", p.Index)
		}
		m[p.Index] = p.Value
	}
	return m
}

func checkEmitted(t *testing.T, pts []Point, want map[int64]*big.Rat) {
	t.Helper()
	got := pointsToMap(t, pts)
	if len(got) != len(want) {
		t.Fatalf("emitted %d points, want %d\ngot:  %v\nwant: %v", len(got), len(want), got, want)
	}
	for i, wv := range want {
		gv, ok := got[i]
		if !ok {
			t.Fatalf("missing emitted index %d (want %v)\ngot: %v", i, wv, got)
		}
		if gv.Cmp(wv) != 0 {
			t.Fatalf("index %d: got %v, want %v", i, gv, wv)
		}
	}
}

func TestFillInternalGap(t *testing.T) {
	samples := map[int64]*big.Rat{0: rat(0, 1), 3: rat(6, 1)}
	checkEmitted(t, Fill(samples, 2), map[int64]*big.Rat{
		0: rat(0, 1), 1: rat(2, 1), 2: rat(4, 1), 3: rat(6, 1),
	})
}

func TestGapLongerThanMNotFilled(t *testing.T) {
	samples := map[int64]*big.Rat{0: rat(0, 1), 4: rat(8, 1)}
	// gap length 3 > m=2: only observed points emitted
	checkEmitted(t, Fill(samples, 2), map[int64]*big.Rat{
		0: rat(0, 1), 4: rat(8, 1),
	})
	// gap length exactly m=3: filled
	checkEmitted(t, Fill(samples, 3), map[int64]*big.Rat{
		0: rat(0, 1), 1: rat(2, 1), 2: rat(4, 1), 3: rat(6, 1), 4: rat(8, 1),
	})
}

func TestMZeroFillsNothing(t *testing.T) {
	samples := map[int64]*big.Rat{0: rat(1, 1), 2: rat(3, 1)}
	checkEmitted(t, Fill(samples, 0), map[int64]*big.Rat{
		0: rat(1, 1), 2: rat(3, 1),
	})
}

func TestRationalInterpolationExact(t *testing.T) {
	samples := map[int64]*big.Rat{0: rat(1, 3), 2: rat(1, 2)}
	checkEmitted(t, Fill(samples, 1), map[int64]*big.Rat{
		0: rat(1, 3), 1: rat(5, 12), 2: rat(1, 2),
	})
}

func TestSingleSample(t *testing.T) {
	checkEmitted(t, Fill(map[int64]*big.Rat{7: rat(5, 1)}, 4), map[int64]*big.Rat{
		7: rat(5, 1),
	})
}

func TestEmpty(t *testing.T) {
	if got := Fill(nil, 3); len(got) != 0 {
		t.Fatalf("want no points, got %v", got)
	}
}

// applyDelta folds a delta into a consumer-side emitted map, verifying
// that every retraction matches the value previously emitted.
func applyDelta(t *testing.T, emitted map[int64]*big.Rat, d Delta) {
	t.Helper()
	for _, p := range d.Retracted {
		old, ok := emitted[p.Index]
		if !ok {
			t.Fatalf("retracted index %d was never emitted", p.Index)
		}
		if old.Cmp(p.Value) != 0 {
			t.Fatalf("retracted index %d: emitted %v, delta says %v", p.Index, old, p.Value)
		}
		delete(emitted, p.Index)
	}
	for _, p := range d.Added {
		emitted[p.Index] = new(big.Rat).Set(p.Value)
	}
}

func checkSeries(t *testing.T, s *Series, samples map[int64]*big.Rat, m int64, emitted map[int64]*big.Rat) {
	t.Helper()
	want := pointsToMap(t, Fill(samples, m))
	if len(emitted) != len(want) {
		t.Fatalf("consumer emitted %d points, full fill has %d", len(emitted), len(want))
	}
	for i, wv := range want {
		gv, ok := emitted[i]
		if !ok || gv.Cmp(wv) != 0 {
			t.Fatalf("index %d: consumer has %v (ok=%v), full fill %v", i, gv, ok, wv)
		}
	}
	checkEmitted(t, s.Emitted(), want)
}

func TestDeltaOnFirstSample(t *testing.T) {
	s := New(2)
	d := s.Add(5, rat(3, 1))
	if len(d.Retracted) != 0 || len(d.Added) != 1 || d.Added[0].Index != 5 {
		t.Fatalf("unexpected delta: %+v", d)
	}
}

func TestDeltaSplittingGap(t *testing.T) {
	s := New(2)
	emitted := map[int64]*big.Rat{}
	samples := map[int64]*big.Rat{}

	add := func(i int64, v *big.Rat) {
		d := s.Add(i, v)
		applyDelta(t, emitted, d)
		samples[i] = v
		checkSeries(t, s, samples, 2, emitted)
	}

	add(0, rat(0, 1))
	add(5, rat(10, 1)) // gap of 4 > m: nothing filled
	if len(emitted) != 2 {
		t.Fatalf("gap of 4 with m=2 must not be filled, emitted: %v", emitted)
	}
	add(2, rat(4, 1)) // splits into gaps of 1 and 2, both filled
	checkEmitted(t, s.Emitted(), map[int64]*big.Rat{
		0: rat(0, 1), 1: rat(2, 1), 2: rat(4, 1), 3: rat(6, 1), 4: rat(8, 1), 5: rat(10, 1),
	})
}

func TestDeltaExtendingRange(t *testing.T) {
	s := New(2)
	emitted := map[int64]*big.Rat{}
	samples := map[int64]*big.Rat{}
	add := func(i int64, v *big.Rat) {
		d := s.Add(i, v)
		applyDelta(t, emitted, d)
		samples[i] = v
		checkSeries(t, s, samples, 2, emitted)
	}
	add(3, rat(6, 1))
	add(5, rat(10, 1))
	// New minimum at 0: indices 1,2 were leading missing (never emitted),
	// now they form an internal gap of 2 and appear as additions.
	d := s.Add(0, rat(0, 1))
	samples[0] = rat(0, 1)
	applyDelta(t, emitted, d)
	if len(d.Retracted) != 0 {
		t.Fatalf("extending the range must not retract, got %+v", d.Retracted)
	}
	checkSeries(t, s, samples, 2, emitted)
	checkEmitted(t, s.Emitted(), map[int64]*big.Rat{
		0: rat(0, 1), 1: rat(2, 1), 2: rat(4, 1), 3: rat(6, 1), 4: rat(8, 1), 5: rat(10, 1),
	})
}

func TestDeltaUpdatingSample(t *testing.T) {
	s := New(2)
	emitted := map[int64]*big.Rat{}
	samples := map[int64]*big.Rat{}
	add := func(i int64, v *big.Rat) {
		d := s.Add(i, v)
		applyDelta(t, emitted, d)
		samples[i] = v
		checkSeries(t, s, samples, 2, emitted)
	}
	add(0, rat(0, 1))
	add(2, rat(4, 1))
	add(4, rat(8, 1))
	// Update the middle sample: its own point and both adjacent fills change.
	d := s.Add(2, rat(10, 1))
	samples[2] = rat(10, 1)
	applyDelta(t, emitted, d)
	checkSeries(t, s, samples, 2, emitted)
	checkEmitted(t, s.Emitted(), map[int64]*big.Rat{
		0: rat(0, 1), 1: rat(5, 1), 2: rat(10, 1), 3: rat(9, 1), 4: rat(8, 1),
	})
	// Re-adding the same value is a no-op.
	if d := s.Add(2, rat(10, 1)); !d.Empty() {
		t.Fatalf("re-adding identical value must be a no-op, got %+v", d)
	}
}

// TestIncrementalMatchesFullFill adds and updates samples in a random
// order and, after every step, verifies that the series maintained
// through deltas equals a from-scratch fill of the full sample set.
func TestIncrementalMatchesFullFill(t *testing.T) {
	for _, m := range []int64{0, 1, 2, 3, 5} {
		t.Run("", func(t *testing.T) {
			rng := rand.New(rand.NewSource(int64(20261005 + m)))
			s := New(m)
			emitted := map[int64]*big.Rat{}
			samples := map[int64]*big.Rat{}
			for step := 0; step < 300; step++ {
				i := rng.Int63n(40)
				v := big.NewRat(rng.Int63n(2001)-1000, 1+rng.Int63n(7))
				d := s.Add(i, v)
				applyDelta(t, emitted, d)
				samples[i] = v
				checkSeries(t, s, samples, m, emitted)
			}
		})
	}
}
