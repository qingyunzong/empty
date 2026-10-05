package trendlib

import (
	"math"
	"math/big"
	"math/rand"
	"sort"
	"testing"
)

// The naive reference model below is deliberately independent of the index
// implementation: it rebuilds effective samples by replaying corrections
// and regresses by direct per-point rational summation.

// naiveEffectiveSamples rebuilds the effective sample list as of version by
// replaying correction ranges directly.
func naiveEffectiveSamples(base []Sample, batches []Batch, version int) []Sample {
	samples := append([]Sample(nil), base...)
	for v := 0; v < version; v++ {
		for _, c := range batches[v].Corrections {
			if c.Start >= c.End {
				continue
			}
			var next []Sample
			for _, s := range samples {
				if s.T < c.Start || s.T >= c.End {
					next = append(next, s)
				}
			}
			next = append(next, c.Samples...)
			sort.SliceStable(next, func(i, j int) bool { return next[i].T < next[j].T })
			samples = next
		}
	}
	return samples
}

func naiveMeanAt(samples []Sample, t int64) *big.Rat {
	sum := new(big.Rat)
	var n int64
	for _, s := range samples {
		if s.T == t {
			sum.Add(sum, new(big.Rat).SetInt64(s.V))
			n++
		}
	}
	return sum.Quo(sum, new(big.Rat).SetInt64(n))
}

func naiveInterp(samples []Sample, e int64) ([2]*big.Rat, bool) {
	var zero [2]*big.Rat
	t1, t2 := int64(math.MinInt64), int64(math.MaxInt64)
	exact := false
	for _, s := range samples {
		switch {
		case s.T == e:
			exact = true
		case s.T < e && s.T > t1:
			t1 = s.T
		case s.T > e && s.T < t2:
			t2 = s.T
		}
	}
	if exact || t1 == math.MinInt64 || t2 == math.MaxInt64 {
		return zero, false
	}
	y1, y2 := naiveMeanAt(samples, t1), naiveMeanAt(samples, t2)
	y := new(big.Rat).Sub(y2, y1)
	y.Mul(y, big.NewRat(e-t1, t2-t1))
	y.Add(y, y1)
	return [2]*big.Rat{big.NewRat(e, 1), y}, true
}

// naivePoints selects interior samples plus interpolated edge points.
func naivePoints(samples []Sample, lo, hi int64) [][2]*big.Rat {
	var pts [][2]*big.Rat
	if lo >= hi {
		return pts
	}
	for _, s := range samples {
		if s.T >= lo && s.T < hi {
			pts = append(pts, [2]*big.Rat{big.NewRat(s.T, 1), big.NewRat(s.V, 1)})
		}
	}
	for _, e := range [2]int64{lo, hi} {
		if p, ok := naiveInterp(samples, e); ok {
			pts = append(pts, p)
		}
	}
	return pts
}

// naiveRegress regresses by direct per-point rational summation around the
// means, with no shared aggregation code.
func naiveRegress(pts [][2]*big.Rat) (slope, rss *big.Rat) {
	if len(pts) == 0 {
		return nil, new(big.Rat)
	}
	mx, my := new(big.Rat), new(big.Rat)
	for _, p := range pts {
		mx.Add(mx, p[0])
		my.Add(my, p[1])
	}
	n := new(big.Rat).SetInt64(int64(len(pts)))
	mx.Quo(mx, n)
	my.Quo(my, n)

	sxx, sxy := new(big.Rat), new(big.Rat)
	for _, p := range pts {
		dx := new(big.Rat).Sub(p[0], mx)
		dy := new(big.Rat).Sub(p[1], my)
		sxx.Add(sxx, new(big.Rat).Mul(dx, dx))
		sxy.Add(sxy, new(big.Rat).Mul(dx, dy))
	}
	if sxx.Sign() == 0 {
		rss = new(big.Rat)
		for _, p := range pts {
			dy := new(big.Rat).Sub(p[1], my)
			rss.Add(rss, new(big.Rat).Mul(dy, dy))
		}
		return nil, rss
	}
	b := new(big.Rat).Quo(sxy, sxx)
	rss = new(big.Rat)
	for _, p := range pts {
		r := new(big.Rat).Sub(p[0], mx)
		r.Mul(r, b)
		r.Sub(new(big.Rat).Sub(p[1], my), r)
		rss.Add(rss, new(big.Rat).Mul(r, r))
	}
	return b, rss
}

func randomScenario(seed int64) ([]Sample, []Batch) {
	rng := rand.New(rand.NewSource(seed))
	randSamples := func(n int, lo, hi int64) []Sample {
		s := make([]Sample, n)
		for i := range s {
			s[i] = Sample{T: lo + int64(rng.Intn(int(hi-lo))), V: int64(rng.Intn(41) - 20)}
		}
		return s
	}
	base := randSamples(60, 0, 100)
	var batches []Batch
	for b := 0; b < 8; b++ {
		var batch Batch
		for k := 0; k < 1+rng.Intn(3); k++ {
			start := int64(rng.Intn(85))
			end := start + 2 + int64(rng.Intn(20))
			batch.Corrections = append(batch.Corrections, Correction{
				Start:   start,
				End:     end,
				Samples: randSamples(rng.Intn(8), start, end),
			})
		}
		batches = append(batches, batch)
	}
	return base, batches
}

func checkQueryEqual(t *testing.T, ix *Index, samples []Sample, lo, hi int64, version int) {
	t.Helper()
	wantSlope, wantRSS := naiveRegress(naivePoints(samples, lo, hi))
	gotSlope, gotRSS, err := ix.Query(lo, hi, version)
	if err != nil {
		t.Fatalf("v%d [%d,%d): %v", version, lo, hi, err)
	}
	if (wantSlope == nil) != (gotSlope == nil) {
		t.Fatalf("v%d [%d,%d): slope nil mismatch: naive=%v index=%v", version, lo, hi, wantSlope, gotSlope)
	}
	if wantSlope != nil && wantSlope.Cmp(gotSlope) != 0 {
		t.Fatalf("v%d [%d,%d): slope naive=%v index=%v", version, lo, hi, wantSlope, gotSlope)
	}
	if wantRSS.Cmp(gotRSS) != 0 {
		t.Fatalf("v%d [%d,%d): rss naive=%v index=%v", version, lo, hi, wantRSS, gotRSS)
	}
}

// TestGridRecomputeAgainstNaiveModel recomputes regression statistics over
// the full two-dimensional grid of business-time ranges x commit versions
// and checks the index against the direct rational summation model.
func TestGridRecomputeAgainstNaiveModel(t *testing.T) {
	base, batches := randomScenario(1)
	ix := NewIndex(base)
	for _, b := range batches {
		ix.Publish(b)
	}
	var ranges [][2]int64
	grid := []int64{0, 3, 10, 17, 25, 33, 50, 66, 80, 99, 120}
	for _, lo := range grid {
		for _, hi := range grid {
			if lo < hi {
				ranges = append(ranges, [2]int64{lo, hi})
			}
		}
	}
	for version := 0; version <= len(batches); version++ {
		samples := naiveEffectiveSamples(base, batches, version)
		for _, r := range ranges {
			checkQueryEqual(t, ix, samples, r[0], r[1], version)
		}
	}
}

// TestHistoricalVersionsIgnoreFutureCorrections verifies that querying an
// old version never observes corrections committed later.
func TestHistoricalVersionsIgnoreFutureCorrections(t *testing.T) {
	base := []Sample{{0, 0}, {10, 10}, {20, 20}}
	b1 := Batch{Corrections: []Correction{{Start: 5, End: 15, Samples: []Sample{{7, 999}, {12, -999}}}}}
	b2 := Batch{Corrections: []Correction{{Start: 0, End: 30, Samples: []Sample{{3, 1}, {9, 2}}}}}

	ix := NewIndex(base)
	ix.Publish(b1)
	ix.Publish(b2)
	batches := []Batch{b1, b2}

	for version := 0; version <= 2; version++ {
		samples := naiveEffectiveSamples(base, batches, version)
		for lo := int64(-3); lo < 25; lo += 2 {
			for hi := lo + 1; hi < 28; hi += 3 {
				checkQueryEqual(t, ix, samples, lo, hi, version)
			}
		}
	}

	// Version 0 results must be identical to a fresh base-only index.
	fresh := NewIndex(base)
	for _, r := range [][2]int64{{0, 25}, {5, 15}, {6, 14}} {
		s0, r0 := mustQuery(t, ix, r[0], r[1], 0)
		sf, rf := mustQuery(t, fresh, r[0], r[1], 0)
		if s0.Cmp(sf) != 0 || r0.Cmp(rf) != 0 {
			t.Fatalf("version 0 query [%d,%d) changed by future corrections", r[0], r[1])
		}
	}
	// And the corrections must actually have had an effect on later versions.
	s0, r0 := mustQuery(t, ix, 0, 25, 0)
	s2, r2 := mustQuery(t, ix, 0, 25, 2)
	if s0.Cmp(s2) == 0 && r0.Cmp(r2) == 0 {
		t.Fatal("corrections had no observable effect on the latest version")
	}
}
