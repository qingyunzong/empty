package setlib

import (
	"reflect"
	"testing"
)

func TestNormalize(t *testing.T) {
	cases := []struct {
		name string
		in   []Interval
		want []Interval
	}{
		{"nil", nil, nil},
		{"invalid dropped", []Interval{{5, 5}, {7, 3}, {1, 4}}, []Interval{{1, 4}}},
		{"unsorted", []Interval{{8, 10}, {0, 3}}, []Interval{{0, 3}, {8, 10}}},
		{"overlap merged", []Interval{{0, 5}, {3, 8}}, []Interval{{0, 8}}},
		{"adjacent merged", []Interval{{0, 5}, {5, 8}, {8, 9}}, []Interval{{0, 9}}},
		{"nested merged", []Interval{{0, 10}, {2, 4}, {4, 6}}, []Interval{{0, 10}}},
		{"gap kept", []Interval{{0, 3}, {4, 6}}, []Interval{{0, 3}, {4, 6}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Normalize(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Normalize(%v) = %v, want %v", tc.in, got, tc.want)
			}
			if !IsNormalized(got) {
				t.Fatalf("Normalize(%v) = %v is not normalized", tc.in, got)
			}
		})
	}
}

func TestIsNormalized(t *testing.T) {
	if IsNormalized([]Interval{{2, 1}}) {
		t.Fatal("invalid interval accepted")
	}
	if IsNormalized([]Interval{{0, 3}, {3, 5}}) {
		t.Fatal("adjacent intervals accepted")
	}
	if IsNormalized([]Interval{{4, 6}, {0, 2}}) {
		t.Fatal("unsorted intervals accepted")
	}
	if !IsNormalized([]Interval{{0, 2}, {4, 6}}) {
		t.Fatal("canonical form rejected")
	}
}

func TestIntersectEvidence(t *testing.T) {
	sets := map[string][]Interval{
		"A": {{0, 5}, {5, 8}}, // adjacent pair: forces a merge in the result
		"B": {{0, 8}},
		"C": {{2, 6}},
	}
	got := Intersect(sets)
	if len(got) != 1 || got[0].Interval != (Interval{2, 6}) {
		t.Fatalf("Intersect = %+v, want single interval [2,6)", got)
	}
	// Evidence must retain both of A's adjacent source intervals.
	var aContrib []Interval
	for _, c := range got[0].Evidence {
		if c.SetID == "A" {
			aContrib = append(aContrib, c.Interval)
		}
	}
	want := []Interval{{0, 5}, {5, 8}}
	if !reflect.DeepEqual(aContrib, want) {
		t.Fatalf("A evidence = %v, want %v (merge must retain source evidence)", aContrib, want)
	}
	if n := len(got[0].Evidence); n != 4 { // A:2, B:1, C:1
		t.Fatalf("evidence count = %d, want 4", n)
	}
}

func TestIntersectorIncremental(t *testing.T) {
	x := NewIntersector(0, 32)
	x.Upsert("A", []Interval{{0, 10}})
	x.Upsert("B", []Interval{{0, 2}, {5, 15}})
	assertIntervals(t, x.Query(), []Interval{{0, 2}, {5, 10}})

	// Single-member correction: only A changes.
	x.Upsert("A", []Interval{{7, 20}})
	assertIntervals(t, x.Query(), []Interval{{7, 15}})

	x.Remove("B")
	assertIntervals(t, x.Query(), []Interval{{7, 20}})

	x.Remove("A")
	if got := x.Query(); got != nil {
		t.Fatalf("empty intersector Query = %v, want nil", got)
	}
}

func TestUpsertNormalizesInput(t *testing.T) {
	x := NewIntersector(0, 32)
	x.Upsert("A", []Interval{{0, 5}, {5, 8}, {9, 9}, {20, 30}})
	x.Upsert("B", []Interval{{0, 32}})
	assertIntervals(t, x.Query(), []Interval{{0, 8}, {20, 30}})
}

func assertIntervals(t *testing.T, got []Result, want []Interval) {
	t.Helper()
	ivs := make([]Interval, len(got))
	for i, r := range got {
		ivs[i] = r.Interval
	}
	if !reflect.DeepEqual(ivs, want) {
		t.Fatalf("intervals = %v, want %v", ivs, want)
	}
	if !IsNormalized(ivs) {
		t.Fatalf("output %v is not normalized", ivs)
	}
}
