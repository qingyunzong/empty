package setlib

import (
	"fmt"
	"math/rand"
	"testing"
)

// bruteForceIntersection recomputes the intersection point by point with no
// shared code with the incremental implementation.
func bruteForceIntersection(sets map[string][]Interval, lo, hi int) []Interval {
	ids := make([]string, 0, len(sets))
	for id := range sets {
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil
	}
	var out []Interval
	for p := lo; p < hi; p++ {
		all := true
		for _, id := range ids {
			found := false
			for _, iv := range sets[id] {
				if iv.Contains(p) {
					found = true
					break
				}
			}
			if !found {
				all = false
				break
			}
		}
		if all {
			if n := len(out); n > 0 && out[n-1].Hi == p {
				out[n-1].Hi = p + 1
			} else {
				out = append(out, Interval{p, p + 1})
			}
		}
	}
	return out
}

// verifyEvidence checks that every result interval is fully explained by its
// evidence: each contribution belongs to a set, overlaps the result, and the
// contributions of every set jointly cover the whole result interval.
func verifyEvidence(t *testing.T, x *Intersector, results []Result) {
	t.Helper()
	for _, r := range results {
		cover := map[string][]Interval{}
		for _, c := range r.Evidence {
			src, ok := x.sets[c.SetID]
			if !ok {
				t.Fatalf("evidence references unknown set %q", c.SetID)
			}
			belongs := false
			for _, iv := range src {
				if iv == c.Interval {
					belongs = true
					break
				}
			}
			if !belongs {
				t.Fatalf("evidence interval %v not a source interval of set %q", c.Interval, c.SetID)
			}
			if !Overlaps(c.Interval, r.Interval) {
				t.Fatalf("evidence interval %v does not overlap result %v", c.Interval, r.Interval)
			}
			lo, hi := c.Interval.Lo, c.Interval.Hi
			if lo < r.Interval.Lo {
				lo = r.Interval.Lo
			}
			if hi > r.Interval.Hi {
				hi = r.Interval.Hi
			}
			cover[c.SetID] = append(cover[c.SetID], Interval{lo, hi})
		}
		for id := range x.sets {
			merged := Normalize(cover[id])
			if len(merged) != 1 || merged[0] != r.Interval {
				t.Fatalf("evidence of set %q covers %v, does not fully explain result %v",
					id, merged, r.Interval)
			}
		}
	}
}

// TestPerTickSimulation drives a small integer domain through many ticks of
// random single-member corrections and, after every tick, cross-checks the
// incremental intersection against a brute-force recomputation and verifies
// output normalization and evidence soundness.
func TestPerTickSimulation(t *testing.T) {
	const (
		domain  = 48
		numSets = 6
		ticks   = 3000
	)
	rng := rand.New(rand.NewSource(20261005))
	x := NewIntersector(0, domain)
	sets := make(map[string][]Interval)
	ids := make([]string, 0, numSets)
	for i := 0; i < numSets; i++ {
		ids = append(ids, fmt.Sprintf("S%d", i))
	}

	randomIntervals := func() []Interval {
		n := rng.Intn(4)
		ivs := make([]Interval, 0, n)
		for j := 0; j < n; j++ {
			lo := rng.Intn(domain)
			hi := lo + rng.Intn(domain-lo) // may equal lo: invalid, must be dropped
			ivs = append(ivs, Interval{lo, hi})
		}
		return ivs
	}

	for tick := 0; tick < ticks; tick++ {
		id := ids[rng.Intn(len(ids))]
		switch rng.Intn(10) {
		case 0: // remove a member entirely
			x.Remove(id)
			delete(sets, id)
		default: // single-member correction
			ivs := randomIntervals()
			x.Upsert(id, ivs)
			sets[id] = Normalize(ivs)
		}

		got := x.Query()
		gotIvs := make([]Interval, len(got))
		for i, r := range got {
			gotIvs[i] = r.Interval
		}
		want := bruteForceIntersection(sets, 0, domain)

		if !IsNormalized(gotIvs) {
			t.Fatalf("tick %d: output %v violates normalization", tick, gotIvs)
		}
		if fmt.Sprint(gotIvs) != fmt.Sprint(want) {
			t.Fatalf("tick %d: incremental = %v, brute force = %v", tick, gotIvs, want)
		}
		verifyEvidence(t, x, got)
	}
}
