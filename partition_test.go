package dataeng

import (
	"errors"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

func bruteForce(nodes []string, cands []Candidate, anchors []int) (*Partition, bool) {
	var best []Interval
	var bestProfit int64
	var bestCount int
	found := false

	for mask := 0; mask < 1<<len(cands); mask++ {
		var picked []Candidate
		var profit int64
		for bit := 0; bit < len(cands); bit++ {
			if mask&(1<<bit) != 0 {
				picked = append(picked, cands[bit])
				profit += cands[bit].Profit
			}
		}

		sort.Slice(picked, func(i, j int) bool {
			if picked[i].Start != picked[j].Start {
				return picked[i].Start < picked[j].Start
			}
			return picked[i].End < picked[j].End
		})
		ok := true
		for i := 1; i < len(picked); i++ {
			if picked[i].Start < picked[i-1].End {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}

		for _, anchor := range anchors {
			cover := 0
			for _, cand := range picked {
				if cand.Start <= anchor && anchor < cand.End {
					cover++
				}
			}
			if cover != 1 {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}

		spans := make([]Interval, len(picked))
		for i, cand := range picked {
			spans[i] = Interval{Start: cand.Start, End: cand.End}
		}
		if !found || prefer(spans, len(spans), profit, best, bestCount, bestProfit) {
			best = spans
			bestCount = len(spans)
			bestProfit = profit
			found = true
		}
	}

	if !found {
		return nil, false
	}
	return &Partition{Intervals: best, Records: bestCount, Profit: bestProfit}, true
}

func prefer(spans []Interval, count int, profit int64, other []Interval, otherCount int, otherProfit int64) bool {
	if profit != otherProfit {
		return profit > otherProfit
	}
	if count != otherCount {
		return count < otherCount
	}
	for i := 0; i < count; i++ {
		if spans[i].Start != other[i].Start {
			return spans[i].Start < other[i].Start
		}
		if spans[i].End != other[i].End {
			return spans[i].End < other[i].End
		}
	}
	return false
}

func makeNodes(n int) []string {
	nodes := make([]string, n)
	for i := range nodes {
		nodes[i] = "n"
	}
	return nodes
}

func TestNoAnchorPrefersFewerRecordsOnTie(t *testing.T) {
	nodes := makeNodes(5)
	cands := []Candidate{
		{Start: 0, End: 2, Profit: 3},
		{Start: 2, End: 4, Profit: 3},
		{Start: 0, End: 4, Profit: 6},
	}
	got, err := BestPartition(nodes, cands, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := &Partition{
		Intervals: []Interval{{Start: 0, End: 4}},
		Records:   1,
		Profit:    6,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestTouchingIntervalsCoverAnchors(t *testing.T) {
	nodes := makeNodes(6)
	cands := []Candidate{
		{Start: 0, End: 2, Profit: 5},
		{Start: 2, End: 4, Profit: 7},
		{Start: 4, End: 6, Profit: 2},
		{Start: 0, End: 6, Profit: 11},
	}
	anchors := []int{1, 3, 5}
	got, err := BestPartition(nodes, cands, anchors)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := &Partition{
		Intervals: []Interval{{Start: 0, End: 2}, {Start: 2, End: 4}, {Start: 4, End: 6}},
		Records:   3,
		Profit:    14,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestAnchorInGapIsInfeasible(t *testing.T) {
	nodes := makeNodes(6)
	cands := []Candidate{
		{Start: 0, End: 2, Profit: 5},
		{Start: 3, End: 5, Profit: 7},
	}
	_, err := BestPartition(nodes, cands, []int{2})
	if !errors.Is(err, ErrInfeasible) {
		t.Fatalf("got %v, want ErrInfeasible", err)
	}
}

func TestOverlappingAnchorDoubleCoverIsInfeasible(t *testing.T) {
	nodes := makeNodes(4)
	cands := []Candidate{
		{Start: 0, End: 3, Profit: 5},
		{Start: 2, End: 4, Profit: 5},
	}
	// Anchor 2 lies in both intervals; selecting both overlaps anyway, and
	// selecting either alone leaves some case uncovered when anchors span both.
	_, err := BestPartition(nodes, cands, []int{1, 3})
	if !errors.Is(err, ErrInfeasible) {
		t.Fatalf("got %v, want ErrInfeasible", err)
	}
}

func TestLexicographicTieBreak(t *testing.T) {
	nodes := makeNodes(6)
	cands := []Candidate{
		{Start: 0, End: 3, Profit: 4},
		{Start: 3, End: 6, Profit: 4},
		{Start: 0, End: 2, Profit: 2},
		{Start: 2, End: 6, Profit: 6},
	}
	// Both two-interval selections total 8; ([0,2),[2,6)) is lexicographically
	// smaller than ([0,3),[3,6)).
	got, err := BestPartition(nodes, cands, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := &Partition{
		Intervals: []Interval{{Start: 0, End: 2}, {Start: 2, End: 6}},
		Records:   2,
		Profit:    8,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestEmptyInputs(t *testing.T) {
	got, err := BestPartition(nil, nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := &Partition{Intervals: []Interval{}, Records: 0, Profit: 0}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestValidationErrors(t *testing.T) {
	cases := []struct {
		name    string
		nodes   []string
		cands   []Candidate
		anchors []int
	}{
		{"empty interval", makeNodes(3), []Candidate{{Start: 1, End: 1, Profit: 1}}, nil},
		{"start negative", makeNodes(3), []Candidate{{Start: -1, End: 1, Profit: 1}}, nil},
		{"end beyond nodes", makeNodes(3), []Candidate{{Start: 0, End: 4, Profit: 1}}, nil},
		{"negative profit", makeNodes(3), []Candidate{{Start: 0, End: 1, Profit: -1}}, nil},
		{"anchor out of range", makeNodes(3), []Candidate{{Start: 0, End: 1, Profit: 1}}, []int{3}},
		{"duplicate anchor", makeNodes(3), []Candidate{{Start: 0, End: 3, Profit: 1}}, []int{1, 1}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := BestPartition(tc.nodes, tc.cands, tc.anchors); err == nil {
				t.Fatal("expected validation error, got nil")
			}
		})
	}
}

func TestRandomFullSubsetExhaustive(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	for iteration := 0; iteration < 2000; iteration++ {
		n := 1 + rng.Intn(8)
		nodes := makeNodes(n)
		m := 1 + rng.Intn(12)
		cands := make([]Candidate, m)
		for i := range cands {
			start := rng.Intn(n)
			end := start + 1 + rng.Intn(n-start)
			cands[i] = Candidate{Start: start, End: end, Profit: int64(rng.Intn(7))}
		}
		anchorCount := rng.Intn(n + 1)
		anchors := rng.Perm(n)[:anchorCount]

		want, feasible := bruteForce(nodes, cands, anchors)
		got, err := BestPartition(nodes, cands, anchors)
		if feasible {
			if err != nil {
				t.Fatalf("iteration %d: unexpected error %v", iteration, err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("iteration %d: got %+v want %+v (cands=%v anchors=%v)",
					iteration, got, want, cands, anchors)
			}
		} else if !errors.Is(err, ErrInfeasible) {
			t.Fatalf("iteration %d: got %v want ErrInfeasible (cands=%v anchors=%v)",
				iteration, err, cands, anchors)
		}
	}
}
