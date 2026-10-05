package coverage

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// scanStore brute-force computes the canonical segmentation by evaluating
// every integer point between the minimum and maximum endpoints. It is
// the independent reference implementation used to check the sweep.
func scanStore(srcs map[string][]Interval) []Segment {
	min, max := 0, 0
	first := true
	for _, ivs := range srcs {
		for _, iv := range ivs {
			if iv.L >= iv.R {
				continue
			}
			if first || iv.L < min {
				min = iv.L
			}
			if first || iv.R > max {
				max = iv.R
			}
			first = false
		}
	}
	if first {
		return nil
	}
	var segs []Segment
	for p := min; p < max; p++ {
		var sum int64
		net := make(map[string]int64)
		for src, ivs := range srcs {
			for _, iv := range ivs {
				if iv.L <= p && p < iv.R {
					sum += iv.W
					net[src] += iv.W
				}
			}
		}
		if sum == 0 {
			continue
		}
		evidence := make([]string, 0, len(net))
		for src, w := range net {
			if w != 0 {
				evidence = append(evidence, src)
			}
		}
		sort.Strings(evidence)
		segs = appendSeg(segs, Segment{L: p, R: p + 1, Sum: sum, Sources: evidence})
	}
	return segs
}

// checkAgainstScan verifies Segments, Total, Max and the per-segment
// source evidence of MaxSegments against the brute-force point scan.
func checkAgainstScan(t *testing.T, st *Store) {
	t.Helper()
	want := scanStore(st.srcs)
	if got := st.Segments(); !reflect.DeepEqual(got, want) {
		t.Fatalf("segments mismatch:\n got %+v\nwant %+v", got, want)
	}
	var wantTotal int64
	for _, seg := range want {
		wantTotal += seg.Sum * int64(seg.R-seg.L)
	}
	if got := st.Total(); got != wantTotal {
		t.Fatalf("total = %d, want %d", got, wantTotal)
	}
	max, pos, ok := st.Max()
	if len(want) == 0 {
		if ok || max != 0 {
			t.Fatalf("empty max = (%d, %v), want (0, false)", max, ok)
		}
		if ms := st.MaxSegments(); ms != nil {
			t.Fatalf("empty max segments = %+v, want nil", ms)
		}
		return
	}
	if !ok {
		t.Fatal("max not ok on non-empty store")
	}
	wantMax, wantPos := want[0].Sum, want[0].L
	for _, seg := range want[1:] {
		if seg.Sum > wantMax {
			wantMax, wantPos = seg.Sum, seg.L
		}
	}
	if max != wantMax || pos != wantPos {
		t.Fatalf("max = (%d @ %d), want (%d @ %d)", max, pos, wantMax, wantPos)
	}
	var wantMaxSegs []Segment
	for _, seg := range want {
		if seg.Sum == wantMax {
			wantMaxSegs = append(wantMaxSegs, seg)
		}
	}
	if got := st.MaxSegments(); !reflect.DeepEqual(got, wantMaxSegs) {
		t.Fatalf("max segments/evidence mismatch:\n got %+v\nwant %+v", got, wantMaxSegs)
	}
}

// randomStore builds a store with small integer coordinates, signed
// weights, zero-length intervals and shared source IDs.
func randomStore(rng *rand.Rand) *Store {
	st := NewStore()
	sources := []string{"a", "b", "c"}
	for i, n := 0, rng.Intn(8); i < n; i++ {
		l := rng.Intn(13) - 2
		r := l + rng.Intn(6) // may be zero-length
		w := int64(rng.Intn(7) - 3)
		st.Add(sources[rng.Intn(len(sources))], Interval{L: l, R: r, W: w})
	}
	return st
}

func TestStoreMatchesScan(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for iter := 0; iter < 5000; iter++ {
		checkAgainstScan(t, randomStore(rng))
	}
}

func TestZeroLengthIgnored(t *testing.T) {
	st := NewStore()
	st.Add("a", Interval{L: 3, R: 3, W: 5}, Interval{L: 5, R: 2, W: 7})
	if got := st.Sources(); len(got) != 0 {
		t.Fatalf("zero-length intervals created source: %v", got)
	}
	if segs := st.Segments(); segs != nil {
		t.Fatalf("segments = %+v, want nil", segs)
	}
	if total := st.Total(); total != 0 {
		t.Fatalf("total = %d, want 0", total)
	}
	if max, _, ok := st.Max(); ok || max != 0 {
		t.Fatalf("max = (%d, %v), want (0, false)", max, ok)
	}
}

func TestEmptyMaxIsZero(t *testing.T) {
	st := NewStore()
	max, _, ok := st.Max()
	if ok || max != 0 {
		t.Fatalf("empty max = (%d, %v), want (0, false)", max, ok)
	}
	if got := st.MaxSegments(); got != nil {
		t.Fatalf("empty max segments = %+v, want nil", got)
	}
	if got := st.Total(); got != 0 {
		t.Fatalf("empty total = %d, want 0", got)
	}
}

func TestNegativeWeights(t *testing.T) {
	st := NewStore()
	st.Add("a", Interval{L: 0, R: 4, W: -2})
	st.Add("b", Interval{L: 2, R: 6, W: -1})
	max, pos, ok := st.Max()
	if !ok || max != -1 || pos != 4 {
		t.Fatalf("max = (%d @ %d, %v), want (-1 @ 4, true)", max, pos, ok)
	}
	want := []Segment{{L: 4, R: 6, Sum: -1, Sources: []string{"b"}}}
	if got := st.MaxSegments(); !reflect.DeepEqual(got, want) {
		t.Fatalf("max segments = %+v, want %+v", got, want)
	}
}

func TestKnownSegmentation(t *testing.T) {
	st := NewStore()
	st.Add("a", Interval{L: 0, R: 4, W: 2})
	st.Add("b", Interval{L: 2, R: 6, W: 3})
	st.Add("a", Interval{L: 4, R: 8, W: 2}) // same source, second interval
	want := []Segment{
		{L: 0, R: 2, Sum: 2, Sources: []string{"a"}},
		{L: 2, R: 6, Sum: 5, Sources: []string{"a", "b"}},
		{L: 6, R: 8, Sum: 2, Sources: []string{"a"}},
	}
	if got := st.Segments(); !reflect.DeepEqual(got, want) {
		t.Fatalf("segments = %+v, want %+v", got, want)
	}
	if got := st.Total(); got != 28 {
		t.Fatalf("total = %d, want 28", got)
	}
	max, pos, ok := st.Max()
	if !ok || max != 5 || pos != 2 {
		t.Fatalf("max = (%d @ %d, %v), want (5 @ 2, true)", max, pos, ok)
	}
}

func TestNetZeroSourceNotEvidence(t *testing.T) {
	st := NewStore()
	st.Add("a", Interval{L: 0, R: 4, W: 1}, Interval{L: 0, R: 4, W: -1})
	st.Add("b", Interval{L: 0, R: 4, W: 5})
	want := []Segment{{L: 0, R: 4, Sum: 5, Sources: []string{"b"}}}
	if got := st.Segments(); !reflect.DeepEqual(got, want) {
		t.Fatalf("segments = %+v, want %+v", got, want)
	}
}
