package main

import (
	"strings"
	"testing"
)

func TestCandidatesGenerated(t *testing.T) {
	p := &Problem{
		BerthLength: 100,
		Step:        30,
		Tides:       []Window{{Start: 600, End: 720}, {Start: 900, End: 960}},
		Ships:       []Ship{{ID: "s", Length: 50, Arrival: 615, Duration: 60}},
	}
	got, err := p.Candidates(p.Ships[0])
	if err != nil {
		t.Fatal(err)
	}
	// window 1: 615..660 step 30 -> {615, 645}; window 2: 900 only (900+60<=960)
	want := []int{615, 645, 900}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestCandidatesExplicitValidation(t *testing.T) {
	p := &Problem{
		BerthLength: 100,
		Step:        30,
		Tides:       []Window{{Start: 0, End: 240}},
		Ships: []Ship{
			{ID: "early", Length: 50, Arrival: 100, Duration: 60, Starts: []int{50}},
			{ID: "outside", Length: 50, Arrival: 0, Duration: 60, Starts: []int{200}},
		},
	}
	if _, err := p.Candidates(p.Ships[0]); err == nil || !strings.Contains(err.Error(), "before arrival") {
		t.Fatalf("expected before-arrival error, got %v", err)
	}
	if _, err := p.Candidates(p.Ships[1]); err == nil || !strings.Contains(err.Error(), "outside all tidal windows") {
		t.Fatalf("expected outside-window error, got %v", err)
	}
}

func TestValidateLimits(t *testing.T) {
	p := &Problem{BerthLength: 100, Step: 30, Tides: []Window{{0, 1440}}}
	for i := 0; i < MaxShips+1; i++ {
		p.Ships = append(p.Ships, Ship{ID: strings.Repeat("x", i+1), Length: 10, Arrival: 0, Duration: 30})
	}
	if err := p.Validate(); err == nil || !strings.Contains(err.Error(), "too many ships") {
		t.Fatalf("expected too-many-ships error, got %v", err)
	}
	p.Ships = p.Ships[:1]
	p.Ships[0] = Ship{ID: "big", Length: 101, Arrival: 0, Duration: 30}
	if err := p.Validate(); err == nil || !strings.Contains(err.Error(), "exceeds berth length") {
		t.Fatalf("expected berth-length error, got %v", err)
	}
}

func TestFeasibleHalfOpenAdjacency(t *testing.T) {
	p := &Problem{
		BerthLength: 100,
		Step:        30,
		Tides:       []Window{{0, 240}},
		Ships: []Ship{
			{ID: "a", Length: 100, Arrival: 0, Duration: 60},
			{ID: "b", Length: 100, Arrival: 0, Duration: 60},
		},
	}
	// [0,60) and [60,120) touch but do not overlap: feasible at capacity 100.
	if !p.feasible([]int{0, 60}) {
		t.Fatal("back-to-back half-open intervals should be feasible")
	}
	if p.feasible([]int{0, 59}) {
		t.Fatal("overlapping intervals exceeding berth length should be infeasible")
	}
}
