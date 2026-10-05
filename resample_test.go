package resample

import (
	"math/big"
	"math/rand"
	"testing"
)

func rat(a, b int64) *big.Rat { return big.NewRat(a, b) }

func pt(t, v *big.Rat) Point { return Point{T: t, V: v} }

type wantSample struct{ t, v *big.Rat }

func checkSamples(t *testing.T, got []Sample, want []wantSample) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d samples, want %d\ngot:  %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i].T.Cmp(want[i].t) != 0 || got[i].V.Cmp(want[i].v) != 0 {
			t.Fatalf("sample %d: got (%s, %s), want (%s, %s)",
				i, got[i].T.RatString(), got[i].V.RatString(),
				want[i].t.RatString(), want[i].v.RatString())
		}
	}
}

// Piecewise linear interpolation on an explicit-origin grid.
func TestBasicLinear(t *testing.T) {
	r := New(rat(0, 1), rat(1, 1))
	var got []Sample
	got = append(got, r.Add(rat(0, 1), rat(0, 1))...)
	got = append(got, r.Add(rat(2, 1), rat(4, 1))...)
	got = append(got, r.Add(rat(4, 1), rat(8, 1))...)
	r.End()
	checkSamples(t, got, []wantSample{
		{rat(0, 1), rat(0, 1)},
		{rat(1, 1), rat(2, 1)},
		{rat(2, 1), rat(4, 1)},
		{rat(3, 1), rat(6, 1)},
		{rat(4, 1), rat(8, 1)},
	})
}

// The origin is explicit: the grid starts at origin even when data does
// not begin there, and grid times need not coincide with input times.
func TestOriginExplicit(t *testing.T) {
	r := New(rat(1, 2), rat(1, 1))
	got := r.AddAll([]Point{pt(rat(0, 1), rat(0, 1)), pt(rat(3, 1), rat(3, 1))})
	r.End()
	checkSamples(t, got, []wantSample{
		{rat(1, 2), rat(1, 2)},
		{rat(3, 2), rat(3, 2)},
		{rat(5, 2), rat(5, 2)},
	})
}

// A break opens a missing segment: no interpolation across the gap.
func TestMissingSegmentNotInterpolated(t *testing.T) {
	r := New(rat(0, 1), rat(1, 1))
	var got []Sample
	got = append(got, r.AddAll([]Point{pt(rat(0, 1), rat(0, 1)), pt(rat(2, 1), rat(2, 1))})...)
	r.Break()
	got = append(got, r.AddAll([]Point{pt(rat(5, 1), rat(50, 1)), pt(rat(7, 1), rat(70, 1))})...)
	r.End()
	checkSamples(t, got, []wantSample{
		{rat(0, 1), rat(0, 1)},
		{rat(1, 1), rat(1, 1)},
		{rat(2, 1), rat(2, 1)},
		// t=3,4 missing: no interpolation across the break
		{rat(5, 1), rat(50, 1)},
		{rat(6, 1), rat(60, 1)},
		{rat(7, 1), rat(70, 1)},
	})
}

// The tail has no right endpoint: nothing past the last point, and the
// End signal does not extrapolate either.
func TestTailNoExtrapolationEvenWithEnd(t *testing.T) {
	r := New(rat(0, 1), rat(1, 1))
	got := r.AddAll([]Point{pt(rat(0, 1), rat(0, 1)), pt(rat(2, 1), rat(2, 1))})
	r.End()
	checkSamples(t, got, []wantSample{
		{rat(0, 1), rat(0, 1)},
		{rat(1, 1), rat(1, 1)},
		{rat(2, 1), rat(2, 1)},
	})
}

// Nothing before the first point either.
func TestHeadNoExtrapolation(t *testing.T) {
	r := New(rat(0, 1), rat(1, 1))
	got := r.AddAll([]Point{pt(rat(2, 1), rat(2, 1)), pt(rat(4, 1), rat(4, 1))})
	r.End()
	checkSamples(t, got, []wantSample{
		{rat(2, 1), rat(2, 1)},
		{rat(3, 1), rat(3, 1)},
		{rat(4, 1), rat(4, 1)},
	})
}

// Rational step landing exactly on input points yields exact values.
func TestRationalStepExactEndpoints(t *testing.T) {
	r := New(rat(0, 1), rat(1, 2))
	got := r.AddAll([]Point{
		pt(rat(0, 1), rat(0, 1)),
		pt(rat(1, 1), rat(2, 1)),
		pt(rat(2, 1), rat(0, 1)),
	})
	r.End()
	checkSamples(t, got, []wantSample{
		{rat(0, 1), rat(0, 1)},
		{rat(1, 2), rat(1, 1)},
		{rat(1, 1), rat(2, 1)},
		{rat(3, 2), rat(1, 1)},
		{rat(2, 1), rat(0, 1)},
	})
}

// Data may start before the origin; coverage still begins at the origin.
func TestDataStartsBeforeOrigin(t *testing.T) {
	r := New(rat(0, 1), rat(1, 1))
	got := r.AddAll([]Point{pt(rat(-3, 1), rat(-6, 1)), pt(rat(1, 1), rat(2, 1))})
	r.End()
	checkSamples(t, got, []wantSample{
		{rat(0, 1), rat(0, 1)},
		{rat(1, 1), rat(2, 1)},
	})
}

// Single-point runs separated by breaks emit only exact grid hits.
func TestSinglePointRuns(t *testing.T) {
	r := New(rat(0, 1), rat(1, 1))
	var got []Sample
	got = append(got, r.Add(rat(0, 1), rat(0, 1))...)
	r.Break()
	got = append(got, r.Add(rat(2, 1), rat(5, 1))...)
	r.Break()
	got = append(got, r.Add(rat(4, 1), rat(9, 1))...)
	r.End()
	checkSamples(t, got, []wantSample{
		{rat(0, 1), rat(0, 1)},
		{rat(2, 1), rat(5, 1)},
		{rat(4, 1), rat(9, 1)},
	})
}

func mustPanic(t *testing.T, name string, f func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Errorf("%s: expected panic", name)
		}
	}()
	f()
}

func TestContractPanics(t *testing.T) {
	mustPanic(t, "zero step", func() { New(rat(0, 1), rat(0, 1)) })
	mustPanic(t, "negative step", func() { New(rat(0, 1), rat(-1, 2)) })
	mustPanic(t, "nil origin", func() { New(nil, rat(1, 1)) })

	r := New(rat(0, 1), rat(1, 1))
	r.Add(rat(2, 1), rat(0, 1))
	mustPanic(t, "equal time", func() { r.Add(rat(2, 1), rat(1, 1)) })
	mustPanic(t, "decreasing time", func() { r.Add(rat(1, 1), rat(1, 1)) })
	r.End()
	mustPanic(t, "add after end", func() { r.Add(rat(3, 1), rat(0, 1)) })
	mustPanic(t, "break after end", func() { r.Break() })
}

// ---- Random chunking vs whole sequence vs independent rational model ----

// modelValue is an independent, non-streaming reference: for grid time g
// it scans the runs for an exact point or a containing segment.
func modelValue(runs [][]Point, g *big.Rat) (*big.Rat, bool) {
	for _, run := range runs {
		for i, p := range run {
			c := p.T.Cmp(g)
			if c == 0 {
				return new(big.Rat).Set(p.V), true
			}
			if c < 0 && i+1 < len(run) && run[i+1].T.Cmp(g) > 0 {
				frac := new(big.Rat).Quo(
					new(big.Rat).Sub(g, p.T),
					new(big.Rat).Sub(run[i+1].T, p.T))
				dv := new(big.Rat).Sub(run[i+1].V, p.V)
				return new(big.Rat).Add(p.V, dv.Mul(dv, frac)), true
			}
		}
	}
	return nil, false
}

// model computes the expected output directly from the whole sequence.
func model(origin, step *big.Rat, runs [][]Point) []Sample {
	var maxT *big.Rat
	for _, run := range runs {
		for _, p := range run {
			if maxT == nil || p.T.Cmp(maxT) > 0 {
				maxT = p.T
			}
		}
	}
	if maxT == nil {
		return nil
	}
	var out []Sample
	g := new(big.Rat).Set(origin)
	for g.Cmp(maxT) <= 0 {
		if v, ok := modelValue(runs, g); ok {
			out = append(out, Sample{T: new(big.Rat).Set(g), V: v})
		}
		g.Add(g, step)
	}
	return out
}

func sameSamples(a, b []Sample) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].T.Cmp(b[i].T) != 0 || a[i].V.Cmp(b[i].V) != 0 {
			return false
		}
	}
	return true
}

func TestRandomChunkedVsWholeVsModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	for iter := 0; iter < 500; iter++ {
		origin := rat(int64(rng.Intn(21)-10), int64(rng.Intn(4)+1))
		step := rat(int64(rng.Intn(5)+1), int64(rng.Intn(4)+1))

		// Build 1..4 runs of random rational points, strictly increasing
		// times across the whole stream, breaks between runs.
		nRuns := 1 + rng.Intn(4)
		runs := make([][]Point, 0, nRuns)
		cur := rat(int64(rng.Intn(11)-8), int64(rng.Intn(3)+1))
		for ri := 0; ri < nRuns; ri++ {
			n := 1 + rng.Intn(8)
			run := make([]Point, 0, n)
			for j := 0; j < n; j++ {
				cur = new(big.Rat).Add(cur, rat(int64(rng.Intn(5)+1), int64(rng.Intn(3)+1)))
				run = append(run, pt(new(big.Rat).Set(cur),
					rat(int64(rng.Intn(41)-20), int64(rng.Intn(3)+1))))
			}
			runs = append(runs, run)
			cur = new(big.Rat).Add(cur, rat(int64(rng.Intn(4)+1), 1)) // gap
		}

		// Whole sequence in one go.
		whole := New(origin, step)
		var gotWhole []Sample
		for ri, run := range runs {
			if ri > 0 {
				whole.Break()
			}
			gotWhole = append(gotWhole, whole.AddAll(run)...)
		}
		whole.End()

		// Same input in random-size chunks.
		chunked := New(origin, step)
		var gotChunked []Sample
		for ri, run := range runs {
			if ri > 0 {
				chunked.Break()
			}
			for rest := run; len(rest) > 0; {
				n := 1 + rng.Intn(len(rest))
				gotChunked = append(gotChunked, chunked.AddAll(rest[:n])...)
				rest = rest[n:]
			}
		}
		chunked.End()

		want := model(origin, step, runs)

		if !sameSamples(gotWhole, want) {
			t.Fatalf("iter %d: whole-sequence output differs from rational model", iter)
		}
		if !sameSamples(gotChunked, want) {
			t.Fatalf("iter %d: randomly chunked output differs from rational model", iter)
		}
	}
}
