package trend

import (
	"math/rand"
	"testing"
)

// randomBatch builds a random batch of corrections over [0, span) with
// duplicate-prone timestamps.
func randomBatch(rng *rand.Rand, span int64, maxCorr int) Batch {
	n := 1 + rng.Intn(maxCorr)
	b := Batch{Corrections: make([]Correction, 0, n)}
	for i := 0; i < n; i++ {
		from := rng.Int63n(span)
		to := from + rng.Int63n(span-from+1)
		var samples []Sample
		for j := 0; j < rng.Intn(5); j++ {
			if to == from {
				break
			}
			samples = append(samples, Sample{
				T: from + rng.Int63n(to-from),
				V: int64(rng.Intn(101) - 50),
			})
		}
		b.Corrections = append(b.Corrections, Correction{From: from, To: to, Samples: samples})
	}
	return b
}

// TestGridRecompute cross-checks the index against the direct rational
// summation model over the full 2D grid of commit versions x query ranges.
func TestGridRecompute(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	const span = 24
	ix := NewIndex()
	m := NewModel()
	const batches = 10
	for i := 0; i < batches; i++ {
		b := randomBatch(rng, span, 3)
		if _, err := ix.Commit(b); err != nil {
			t.Fatalf("index commit %d: %v", i, err)
		}
		if _, err := m.Commit(b); err != nil {
			t.Fatalf("model commit %d: %v", i, err)
		}
	}
	if ix.Versions() != m.Versions() {
		t.Fatalf("version mismatch: %d vs %d", ix.Versions(), m.Versions())
	}
	checked := 0
	for v := 0; v < ix.Versions(); v++ {
		for from := int64(-3); from <= span+3; from++ {
			for to := from; to <= span+3; to++ {
				got, err := ix.Query(v, from, to)
				if err != nil {
					t.Fatalf("index query v=%d [%d,%d]: %v", v, from, to, err)
				}
				want, err := m.Query(v, from, to)
				if err != nil {
					t.Fatalf("model query v=%d [%d,%d]: %v", v, from, to, err)
				}
				if !got.Equal(want) {
					t.Fatalf("v=%d [%d,%d]: index %v != model %v", v, from, to, got, want)
				}
				checked++
			}
		}
	}
	t.Logf("grid cells checked: %d (versions=%d)", checked, ix.Versions())
}

// TestCorrectionMatchesDirectModel is a deterministic post-correction check
// against the direct rational summation model, including interpolated edges.
func TestCorrectionMatchesDirectModel(t *testing.T) {
	ix := NewIndex()
	m := NewModel()
	batches := []Batch{
		{Corrections: []Correction{
			{From: 0, To: 20, Samples: []Sample{{0, 3}, {1, 3}, {4, 9}, {4, 11}, {7, 0}, {12, 5}, {19, 8}}},
		}},
		{Corrections: []Correction{
			{From: 2, To: 8, Samples: []Sample{{2, 100}, {5, -40}, {5, 41}, {7, 7}}},
			{From: 15, To: 20, Samples: []Sample{{16, 2}}},
		}},
		{Corrections: []Correction{
			{From: 0, To: 3, Samples: nil}, // delete-only correction
		}},
	}
	for i, b := range batches {
		if _, err := ix.Commit(b); err != nil {
			t.Fatalf("index commit %d: %v", i, err)
		}
		if _, err := m.Commit(b); err != nil {
			t.Fatalf("model commit %d: %v", i, err)
		}
	}
	ranges := [][2]int64{{0, 19}, {1, 18}, {3, 3}, {5, 5}, {6, 14}, {0, 0}, {19, 19}, {2, 16}, {10, 11}}
	for v := 0; v < ix.Versions(); v++ {
		for _, r := range ranges {
			got, err := ix.Query(v, r[0], r[1])
			if err != nil {
				t.Fatal(err)
			}
			want, err := m.Query(v, r[0], r[1])
			if err != nil {
				t.Fatal(err)
			}
			if !got.Equal(want) {
				t.Fatalf("v=%d [%d,%d]: index %v != model %v", v, r[0], r[1], got, want)
			}
		}
	}
}
