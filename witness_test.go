package permset

import (
	"math"
	"slices"
	"testing"
)

func wantSegs(t *testing.T, w WSet, want []Segment) {
	t.Helper()
	got := w.Segments()
	if len(got) != len(want) {
		t.Fatalf("segments = %v, want %v", w, want)
	}
	for i := range want {
		if got[i].Lo != want[i].Lo || got[i].Hi != want[i].Hi ||
			!slices.Equal(got[i].Sources, want[i].Sources) {
			t.Fatalf("segments = %v, want %v", w, want)
		}
	}
}

func TestWitnessUnionOverlap(t *testing.T) {
	w, err := NewEnv().Eval("[1,5] | [3,8]")
	if err != nil {
		t.Fatal(err)
	}
	wantSegs(t, w, []Segment{
		{1, 2, []string{"[1,5]"}},
		{3, 5, []string{"[1,5]", "[3,8]"}},
		{6, 8, []string{"[3,8]"}},
	})
}

func TestWitnessIntersect(t *testing.T) {
	w, err := NewEnv().Eval("([1,5] | [10,12]) & [4,11]")
	if err != nil {
		t.Fatal(err)
	}
	wantSegs(t, w, []Segment{
		{4, 5, []string{"[1,5]", "[4,11]"}},
		{10, 11, []string{"[10,12]", "[4,11]"}},
	})
}

func TestWitnessDiffKeepsLeftSources(t *testing.T) {
	w, err := NewEnv().Eval("[1,10] - [4,5]")
	if err != nil {
		t.Fatal(err)
	}
	wantSegs(t, w, []Segment{
		{1, 3, []string{"[1,10]"}},
		{6, 10, []string{"[1,10]"}},
	})
}

func TestWitnessDiffAtMaxEndpoint(t *testing.T) {
	w, err := NewEnv().Eval("[0,max] - [max,max]")
	if err != nil {
		t.Fatal(err)
	}
	wantSegs(t, w, []Segment{
		{0, math.MaxInt64 - 1, []string{"[0,max]"}},
	})
}

func TestWitnessNamedReference(t *testing.T) {
	e := NewEnv()
	mustDefine(t, e, "A", "[1,5]")
	w, err := e.Eval("A & [3,9]")
	if err != nil {
		t.Fatal(err)
	}
	wantSegs(t, w, []Segment{
		{3, 5, []string{"A", "[3,9]"}},
	})
}

func TestWitnessAdjacentMergedWhenSourcesEqual(t *testing.T) {
	e := NewEnv()
	mustDefine(t, e, "A", "[1,2] | [3,4]")
	w, err := e.Eval("A | A")
	if err != nil {
		t.Fatal(err)
	}
	// Both adjacent pieces carry the identical witness {A}, so they merge.
	wantSegs(t, w, []Segment{
		{1, 4, []string{"A"}},
	})
}

func TestWitnessAdjacentKeptWhenSourcesDiffer(t *testing.T) {
	w, err := NewEnv().Eval("[1,2] | [3,4]")
	if err != nil {
		t.Fatal(err)
	}
	// Distinct witnesses stay as separate segments...
	wantSegs(t, w, []Segment{
		{1, 2, []string{"[1,2]"}},
		{3, 4, []string{"[3,4]"}},
	})
	// ...while the plain canonical set still merges adjacent intervals.
	if want := (Set{ivs: []Interval{{1, 4}}}); !w.Set().Equal(want) {
		t.Fatalf("Set() = %v, want %v", w.Set(), want)
	}
}

func TestWitnessPropagatesThroughRedefinition(t *testing.T) {
	e := NewEnv()
	mustDefine(t, e, "A", "[1,5]")
	mustDefine(t, e, "B", "A & [2,9]")
	mustDefine(t, e, "A", "[4,6]")
	b, _ := e.Get("B")
	wantSegs(t, b.Wit, []Segment{
		{4, 6, []string{"A", "[2,9]"}},
	})
	if err := e.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}
