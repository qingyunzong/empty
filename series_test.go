package tsfill

import (
	"math/big"
	"math/rand"
	"testing"
)

func rat(s string) *big.Rat {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		panic("bad rational: " + s)
	}
	return r
}

func fillsMap(ps []Point) map[int64]*big.Rat {
	m := make(map[int64]*big.Rat, len(ps))
	for _, p := range ps {
		m[p.T] = p.V
	}
	return m
}

func assertFills(t *testing.T, got []Point, want map[int64]string) {
	t.Helper()
	gm := fillsMap(got)
	if len(gm) != len(want) {
		t.Fatalf("fill count = %d, want %d; got %v", len(gm), len(want), gm)
	}
	for ts, ws := range want {
		gv, ok := gm[ts]
		if !ok {
			t.Fatalf("missing fill at t=%d; got %v", ts, gm)
		}
		if gv.Cmp(rat(ws)) != 0 {
			t.Fatalf("fill at t=%d = %s, want %s", ts, gv, ws)
		}
	}
}

func TestBasicLinearFillExactRationals(t *testing.T) {
	s := New(3)
	s.Add(0, rat("1"))
	d := s.Add(4, rat("1/3"))
	if len(d.Retracted) != 0 {
		t.Fatalf("unexpected retractions: %v", d.Retracted)
	}
	// v(i) = 1 + (1/3 - 1) * i/4 = 1 - i/6
	assertFills(t, s.Fills(), map[int64]string{
		1: "5/6",
		2: "2/3",
		3: "1/2",
	})
	if len(d.Added) != 3 {
		t.Fatalf("added %d points, want 3", len(d.Added))
	}
}

func TestGapLongerThanMNotFilled(t *testing.T) {
	s := New(2)
	s.Add(0, rat("0"))
	s.Add(4, rat("4")) // gap length 3 > m=2
	if got := s.Fills(); len(got) != 0 {
		t.Fatalf("expected no fills, got %v", got)
	}
}

func TestGapExactlyM(t *testing.T) {
	s := New(3)
	s.Add(0, rat("0"))
	s.Add(4, rat("8")) // gap length 3 == m
	assertFills(t, s.Fills(), map[int64]string{1: "2", 2: "4", 3: "6"})

	s2 := New(2)
	s2.Add(0, rat("0"))
	s2.Add(4, rat("8")) // gap length 3 > m=2
	if got := s2.Fills(); len(got) != 0 {
		t.Fatalf("expected no fills, got %v", got)
	}
}

func TestLeadingAndTrailingNotFilled(t *testing.T) {
	s := New(10)
	// Only two samples: times before the first and after the last
	// can never be filled, and there is nothing to fill in between.
	d1 := s.Add(5, rat("10"))
	if len(d1.Added) != 0 || len(d1.Retracted) != 0 {
		t.Fatalf("first sample must not produce fills: %+v", d1)
	}
	s.Add(7, rat("14"))
	assertFills(t, s.Fills(), map[int64]string{6: "12"})
	// Adding a new minimum/maximum extends the known range; the region
	// outside [min, max] stays unfilled by construction.
	s.Add(2, rat("4"))
	assertFills(t, s.Fills(), map[int64]string{3: "6", 4: "8", 6: "12"})
}

func TestInsertionSplitsGapAndRetracts(t *testing.T) {
	s := New(10)
	s.Add(0, rat("0"))
	s.Add(6, rat("12")) // fills 1..5: 2,4,6,8,10
	assertFills(t, s.Fills(), map[int64]string{1: "2", 2: "4", 3: "6", 4: "8", 5: "10"})

	d := s.Add(3, rat("9")) // split gap at t=3
	// Old fills at 1,2,4,5 must be retracted; t=3 was a fill and is now a
	// real sample, so it is retracted too. New fills: 1,2 from gap (0,3)
	// and 4,5 from gap (3,6).
	wantRetract := map[int64]string{1: "2", 2: "4", 3: "6", 4: "8", 5: "10"}
	assertFills(t, d.Retracted, wantRetract)
	assertFills(t, d.Added, map[int64]string{1: "3", 2: "6", 4: "10", 5: "11"})
	assertFills(t, s.Fills(), map[int64]string{1: "3", 2: "6", 4: "10", 5: "11"})
}

func TestInsertionCanRemoveWholeSegment(t *testing.T) {
	s := New(2)
	s.Add(0, rat("0"))
	s.Add(3, rat("6")) // gap 2 <= m: fills 1,2
	assertFills(t, s.Fills(), map[int64]string{1: "2", 2: "4"})
	d := s.Add(1, rat("1")) // gaps (0,1) and (1,3): lengths 0 and 1
	// Fill at 1 is retracted (now a sample); fill at 2 is recomputed.
	assertFills(t, d.Retracted, map[int64]string{1: "2", 2: "4"})
	assertFills(t, d.Added, map[int64]string{2: "7/2"})
	assertFills(t, s.Fills(), map[int64]string{2: "7/2"})
}

func TestDuplicateUpdateRefills(t *testing.T) {
	s := New(5)
	s.Add(0, rat("0"))
	s.Add(4, rat("4"))
	assertFills(t, s.Fills(), map[int64]string{1: "1", 2: "2", 3: "3"})

	d := s.Add(4, rat("8")) // replace value at t=4
	assertFills(t, d.Retracted, map[int64]string{1: "1", 2: "2", 3: "3"})
	assertFills(t, d.Added, map[int64]string{1: "2", 2: "4", 3: "6"})
	assertFills(t, s.Fills(), map[int64]string{1: "2", 2: "4", 3: "6"})

	// Replacing with the same value yields an empty delta.
	d2 := s.Add(4, rat("8"))
	if len(d2.Retracted) != 0 || len(d2.Added) != 0 {
		t.Fatalf("no-op update produced delta: %+v", d2)
	}
}

// TestIncrementalMatchesBatch replays random sample streams, applying each
// returned Delta to a consumer-side view, and after every step checks the
// view (and Series.Fills) against a from-scratch FillAll of all samples.
func TestIncrementalMatchesBatch(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for trial := 0; trial < 200; trial++ {
		m := int64(rng.Intn(5)) // 0..4
		s := New(m)
		samples := make(map[int64]*big.Rat)
		view := make(map[int64]*big.Rat) // consumer state built from deltas

		steps := 1 + rng.Intn(60)
		for step := 0; step < steps; step++ {
			ts := int64(rng.Intn(40)) // duplicates exercise the update path
			v := big.NewRat(int64(rng.Intn(21)-10), int64(1+rng.Intn(7)))
			d := s.Add(ts, v)
			samples[ts] = new(big.Rat).Set(v)

			// Delta must be self-consistent with the consumer view.
			for _, p := range d.Retracted {
				old, ok := view[p.T]
				if !ok {
					t.Fatalf("trial %d step %d: retract of unknown point t=%d", trial, step, p.T)
				}
				if old.Cmp(p.V) != 0 {
					t.Fatalf("trial %d step %d: retract t=%d value %s, view has %s",
						trial, step, p.T, p.V, old)
				}
				delete(view, p.T)
			}
			for _, p := range d.Added {
				view[p.T] = new(big.Rat).Set(p.V)
			}

			want := fillsMap(FillAll(samples, m))
			if len(view) != len(want) {
				t.Fatalf("trial %d step %d: view has %d fills, batch has %d",
					trial, step, len(view), len(want))
			}
			for wt, wv := range want {
				gv, ok := view[wt]
				if !ok || gv.Cmp(wv) != 0 {
					t.Fatalf("trial %d step %d: view[%d]=%v, batch=%s", trial, step, wt, gv, wv)
				}
			}

			// Series.Fills must also match the batch reference exactly.
			if got := fillsMap(s.Fills()); len(got) != len(want) {
				t.Fatalf("trial %d step %d: Series.Fills has %d, batch has %d",
					trial, step, len(got), len(want))
			} else {
				for wt, wv := range want {
					if gv := got[wt]; gv.Cmp(wv) != 0 {
						t.Fatalf("trial %d step %d: Fills[%d]=%s, batch=%s",
							trial, step, wt, gv, wv)
					}
				}
			}
		}
	}
}
