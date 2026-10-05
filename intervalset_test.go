package intervalset

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func TestAddIntervalMergesAdjacentAndKeepsEvidence(t *testing.T) {
	s := NewSet("S")
	s.AddInterval(Interval{1, 3}, "a")
	s.AddInterval(Interval{3, 5}, "b") // adjacent: must merge
	s.AddInterval(Interval{2, 4}, "c") // overlapping: must merge
	s.AddInterval(Interval{9, 9}, "d") // empty: ignored
	want := []EInterval{
		{Interval: Interval{1, 5}, Sources: []string{"a", "b", "c"}},
	}
	if got := s.Intervals(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Intervals() = %v, want %v", got, want)
	}
}

func TestAddSingleMemberBridgesIntervals(t *testing.T) {
	s := NewSet("S")
	s.AddInterval(Interval{0, 2}, "a")
	s.AddInterval(Interval{4, 6}, "b")
	s.Add(2, "p") // extends the left interval
	s.Add(3, "q") // bridges both intervals
	want := []EInterval{
		{Interval: Interval{0, 6}, Sources: []string{"a", "b", "p", "q"}},
	}
	if got := s.Intervals(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Intervals() = %v, want %v", got, want)
	}
	if !s.Contains(5) || s.Contains(6) || s.Contains(-1) {
		t.Fatalf("Contains wrong after bridging: %s", s)
	}
}

func TestRemoveSplitsShrinksAndKeepsEvidence(t *testing.T) {
	s := NewSet("S")
	s.AddInterval(Interval{0, 10}, "a")
	s.Remove(5) // split
	want := []EInterval{
		{Interval: Interval{0, 5}, Sources: []string{"a"}},
		{Interval: Interval{6, 10}, Sources: []string{"a"}},
	}
	if got := s.Intervals(); !reflect.DeepEqual(got, want) {
		t.Fatalf("after split: Intervals() = %v, want %v", got, want)
	}
	s.RemoveInterval(Interval{3, 7}) // shrink both sides
	want = []EInterval{
		{Interval: Interval{0, 3}, Sources: []string{"a"}},
		{Interval: Interval{7, 10}, Sources: []string{"a"}},
	}
	if got := s.Intervals(); !reflect.DeepEqual(got, want) {
		t.Fatalf("after shrink: Intervals() = %v, want %v", got, want)
	}
	s.Remove(0) // drop left edge member
	s.Remove(9) // drop right edge member
	want = []EInterval{
		{Interval: Interval{1, 3}, Sources: []string{"a"}},
		{Interval: Interval{7, 9}, Sources: []string{"a"}},
	}
	if got := s.Intervals(); !reflect.DeepEqual(got, want) {
		t.Fatalf("after edge removes: Intervals() = %v, want %v", got, want)
	}
	s.RemoveInterval(Interval{0, 10})
	if got := s.Intervals(); len(got) != 0 {
		t.Fatalf("after full remove: Intervals() = %v, want empty", got)
	}
}

func TestCanonical(t *testing.T) {
	cases := []struct {
		name string
		ivs  []EInterval
		want bool
	}{
		{"empty", nil, true},
		{"single", []EInterval{{Interval{0, 1}, []string{"a"}}}, true},
		{"gapped", []EInterval{
			{Interval{0, 2}, []string{"a"}},
			{Interval{3, 5}, []string{"b"}},
		}, true},
		{"invalid interval", []EInterval{{Interval{2, 2}, []string{"a"}}}, false},
		{"adjacent not merged", []EInterval{
			{Interval{0, 2}, []string{"a"}},
			{Interval{2, 5}, []string{"b"}},
		}, false},
		{"overlapping", []EInterval{
			{Interval{0, 3}, []string{"a"}},
			{Interval{2, 5}, []string{"b"}},
		}, false},
		{"unsorted", []EInterval{
			{Interval{3, 5}, []string{"a"}},
			{Interval{0, 2}, []string{"b"}},
		}, false},
		{"no sources", []EInterval{{Interval{0, 1}, nil}}, false},
		{"unsorted sources", []EInterval{{Interval{0, 1}, []string{"b", "a"}}}, false},
		{"duplicate sources", []EInterval{{Interval{0, 1}, []string{"a", "a"}}}, false},
	}
	for _, tc := range cases {
		if got := Canonical(tc.ivs); got != tc.want {
			t.Errorf("Canonical(%s) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestIntersect(t *testing.T) {
	a := NewSet("A")
	a.AddInterval(Interval{0, 10}, "a1")
	b := NewSet("B")
	b.AddInterval(Interval{3, 7}, "b1")
	b.AddInterval(Interval{8, 12}, "b2")
	want := []RInterval{
		{Interval: Interval{3, 7}, Evidence: []Evidence{
			{Set: "A", Sources: []string{"a1"}},
			{Set: "B", Sources: []string{"b1"}},
		}},
		{Interval: Interval{8, 10}, Evidence: []Evidence{
			{Set: "A", Sources: []string{"a1"}},
			{Set: "B", Sources: []string{"b2"}},
		}},
	}
	if got := Intersect(a, b); !reflect.DeepEqual(got, want) {
		t.Fatalf("Intersect = %v, want %v", got, want)
	}
}

func TestIntersectEvidenceSurvivesMerges(t *testing.T) {
	// Adjacent inserts merge at set level; the merged interval must
	// carry every contributing tag into the intersection evidence.
	b := NewSet("B")
	b.AddInterval(Interval{0, 5}, "b1")
	b.AddInterval(Interval{5, 10}, "b2")
	a := NewSet("A")
	a.AddInterval(Interval{2, 8}, "a1")
	want := []RInterval{
		{Interval: Interval{2, 8}, Evidence: []Evidence{
			{Set: "A", Sources: []string{"a1"}},
			{Set: "B", Sources: []string{"b1", "b2"}},
		}},
	}
	if got := Intersect(a, b); !reflect.DeepEqual(got, want) {
		t.Fatalf("Intersect = %v, want %v", got, want)
	}
}

func TestIntersectEmpty(t *testing.T) {
	a := NewSet("A")
	a.AddInterval(Interval{0, 3}, "a1")
	if got := Intersect(); got != nil {
		t.Fatalf("Intersect() = %v, want nil", got)
	}
	if got := Intersect(a, NewSet("B")); got != nil {
		t.Fatalf("Intersect with empty set = %v, want nil", got)
	}
	c := NewSet("C")
	c.AddInterval(Interval{5, 9}, "c1")
	if got := Intersect(a, c); got != nil {
		t.Fatalf("Intersect of disjoint sets = %v, want nil", got)
	}
}

func TestMergeAdjacent(t *testing.T) {
	rs := []RInterval{
		{Interval: Interval{0, 3}, Evidence: []Evidence{{Set: "A", Sources: []string{"a1"}}}},
		{Interval: Interval{3, 6}, Evidence: []Evidence{
			{Set: "A", Sources: []string{"a2"}},
			{Set: "B", Sources: []string{"b1"}},
		}},
		{Interval: Interval{8, 9}, Evidence: []Evidence{{Set: "A", Sources: []string{"a3"}}}},
	}
	want := []RInterval{
		{Interval: Interval{0, 6}, Evidence: []Evidence{
			{Set: "A", Sources: []string{"a1", "a2"}},
			{Set: "B", Sources: []string{"b1"}},
		}},
		{Interval: Interval{8, 9}, Evidence: []Evidence{{Set: "A", Sources: []string{"a3"}}}},
	}
	if got := mergeAdjacent(rs); !reflect.DeepEqual(got, want) {
		t.Fatalf("mergeAdjacent = %v, want %v", got, want)
	}
}

func TestString(t *testing.T) {
	s := NewSet("S")
	s.AddInterval(Interval{1, 3}, "a")
	s.Add(5, "b")
	if got, want := s.String(), "S{[1,3)<a>,[5,6)<b>}"; got != want {
		t.Fatalf("String() = %q, want %q", got, want)
	}
}

// bruteForceIntersect computes the intersection membership over the
// small domain directly from the per-element model.
func bruteForceIntersect(model [][]bool, domain int) []Interval {
	var out []Interval
	for x := 0; x < domain; x++ {
		in := true
		for _, m := range model {
			in = in && m[x]
		}
		if in {
			if n := len(out); n > 0 && out[n-1].Hi == x {
				out[n-1].Hi = x + 1
			} else {
				out = append(out, Interval{Lo: x, Hi: x + 1})
			}
		}
	}
	return out
}

// TestSmallDomainPerTick drives random interval and single-member
// corrections over a small integer domain and, after every tick,
// verifies canonical output form, membership against a brute-force
// model, and intersection results with their evidence.
func TestSmallDomainPerTick(t *testing.T) {
	const (
		domain = 24
		nSets  = 4
		ticks  = 2000
	)
	rng := rand.New(rand.NewSource(20261005))
	sets := make([]*Set, nSets)
	model := make([][]bool, nSets)
	usedTags := make([]map[string]bool, nSets)
	for i := range sets {
		sets[i] = NewSet(fmt.Sprintf("S%d", i))
		model[i] = make([]bool, domain)
		usedTags[i] = make(map[string]bool)
	}

	for tick := 0; tick < ticks; tick++ {
		si := rng.Intn(nSets)
		tag := fmt.Sprintf("t%d", tick)
		switch rng.Intn(4) {
		case 0: // add a random interval
			lo := rng.Intn(domain)
			hi := lo + 1 + rng.Intn(domain-lo)
			sets[si].AddInterval(Interval{lo, hi}, tag)
			for x := lo; x < hi; x++ {
				model[si][x] = true
			}
			usedTags[si][tag] = true
		case 1: // remove a random interval
			lo := rng.Intn(domain)
			hi := lo + 1 + rng.Intn(domain-lo)
			sets[si].RemoveInterval(Interval{lo, hi})
			for x := lo; x < hi; x++ {
				model[si][x] = false
			}
		case 2: // add a single member
			x := rng.Intn(domain)
			sets[si].Add(x, tag)
			model[si][x] = true
			usedTags[si][tag] = true
		case 3: // remove a single member
			x := rng.Intn(domain)
			sets[si].Remove(x)
			model[si][x] = false
		}

		// Per-tick: canonical form and membership must match the model.
		for i, s := range sets {
			ivs := s.Intervals()
			if !Canonical(ivs) {
				t.Fatalf("tick %d: %s not canonical: %s", tick, s.Name(), s)
			}
			for x := 0; x < domain; x++ {
				if got := s.Contains(x); got != model[i][x] {
					t.Fatalf("tick %d: %s.Contains(%d) = %v, want %v",
						tick, s.Name(), x, got, model[i][x])
				}
			}
		}

		// Per-tick: intersection must match the brute-force model and
		// carry complete, well-formed evidence.
		res := Intersect(sets...)
		want := bruteForceIntersect(model, domain)
		if len(res) != len(want) {
			t.Fatalf("tick %d: intersection = %v, want %v", tick, res, want)
		}
		for j, r := range res {
			if r.Interval != want[j] {
				t.Fatalf("tick %d: intersection[%d] = %v, want %v",
					tick, j, r.Interval, want[j])
			}
			checkEvidence(t, tick, r, sets, usedTags)
		}
	}
}

// checkEvidence verifies that a result interval carries exactly one
// well-formed evidence entry per input set and that every cited source
// tag was actually inserted into that set.
func checkEvidence(t *testing.T, tick int, r RInterval, sets []*Set, usedTags []map[string]bool) {
	t.Helper()
	if len(r.Evidence) != len(sets) {
		t.Fatalf("tick %d: %v has %d evidence entries, want %d",
			tick, r, len(r.Evidence), len(sets))
	}
	for i, ev := range r.Evidence {
		if ev.Set != sets[i].Name() {
			t.Fatalf("tick %d: %v evidence[%d].Set = %q, want %q",
				tick, r, i, ev.Set, sets[i].Name())
		}
		if !sortedUnique(ev.Sources) {
			t.Fatalf("tick %d: %v evidence[%d] sources not sorted unique",
				tick, r, i)
		}
		for _, src := range ev.Sources {
			if !usedTags[i][src] {
				t.Fatalf("tick %d: %v cites unknown source %q for set %s",
					tick, r, src, ev.Set)
			}
		}
	}
}
