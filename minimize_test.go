package main

import (
	"fmt"
	"math/rand"
	"testing"
)

func TestValidateCap(t *testing.T) {
	s := Scenario{Name: "too-big", Target: "e0"}
	for i := 0; i <= MaxEvents; i++ { // 21 events
		s.Events = append(s.Events, Event{ID: fmt.Sprintf("e%d", i)})
	}
	if err := s.Validate(); err == nil {
		t.Fatalf("expected error for %d events (cap %d)", len(s.Events), MaxEvents)
	}
	s.Events = s.Events[:MaxEvents]
	if err := s.Validate(); err != nil {
		t.Fatalf("expected %d events to be accepted, got %v", MaxEvents, err)
	}
}

func TestValidateDuplicateAndTarget(t *testing.T) {
	dup := Scenario{
		Name:   "dup",
		Target: "a",
		Events: []Event{{ID: "a"}, {ID: "a"}},
	}
	if err := dup.Validate(); err == nil {
		t.Fatal("expected duplicate-ID error")
	}
	noTarget := Scenario{
		Name:   "no-target",
		Target: "missing",
		Events: []Event{{ID: "a"}},
	}
	if err := noTarget.Validate(); err == nil {
		t.Fatal("expected missing-target error")
	}
}

func TestLegal(t *testing.T) {
	s := Scenario{
		Name:    "legality",
		Target:  "use",
		Initial: []string{"seed"},
		Events: []Event{
			{ID: "mk", Reads: []string{"seed"}, Writes: []string{"a"}}, // 0
			{ID: "use", Reads: []string{"a"}},                          // 1
			{ID: "bad", Reads: []string{"nope"}},                       // 2
		},
	}
	cases := []struct {
		sub  []int
		want bool
	}{
		{[]int{0, 1}, true},  // a written before read
		{[]int{1}, false},    // a never written
		{[]int{1, 0}, false}, // same set, but 'use' runs before 'mk' in event order
		{[]int{0}, true},
		{[]int{0, 2}, false}, // unknown resource
		{nil, true},          // empty subsequence is trivially legal
	}
	for _, c := range cases {
		if got := s.Legal(c.sub); got != c.want {
			t.Errorf("Legal(%v) = %v, want %v", c.sub, got, c.want)
		}
	}
}

func TestIllegalSubsequenceIsNotFailure(t *testing.T) {
	s := scenarios["impossible"]
	// Contains the target but its prerequisite is never written: illegal,
	// so it must not count as a failure.
	if s.Fails([]int{3}) {
		t.Fatal("illegal subsequence containing target must not be a failure")
	}
	if got := MinFailing(s, &Evidence{}); got != nil {
		t.Fatalf("expected no failing subsequence, got %v", got)
	}
	var ev Evidence
	if failing := EnumerateAll(s, &ev); len(failing) != 0 {
		t.Fatalf("expected 0 failing subsequences, got %d", len(failing))
	}
	if len(ev.Checks) != 1<<uint(len(s.Events)) {
		t.Fatalf("expected %d evidence records, got %d", 1<<uint(len(s.Events)), len(ev.Checks))
	}
}

func TestMinFailingBuiltins(t *testing.T) {
	want := map[string]int{"small": 4, "fork": 2, "chain20": 4, "impossible": -1}
	for name, wantSize := range want {
		s := scenarios[name]
		var ev Evidence
		got := MinFailing(s, &ev)
		if wantSize < 0 {
			if got != nil {
				t.Errorf("%s: expected no failure, got %v", name, got)
			}
			continue
		}
		if got == nil || len(got) != wantSize {
			t.Errorf("%s: expected minimum size %d, got %v", name, wantSize, got)
			continue
		}
		if !s.Fails(got) {
			t.Errorf("%s: result %v does not reproduce the failure", name, got)
		}
		if !IsOneMinimal(s, got) {
			t.Errorf("%s: result %v is not 1-minimal", name, got)
		}
	}
}

// TestCrossCheckBuiltins verifies, for every built-in scenario, that the
// search result matches the true minimum found by enumerating ALL
// subsequences (2^n, feasible up to the 20-event cap).
func TestCrossCheckBuiltins(t *testing.T) {
	for name, s := range scenarios {
		var ev Evidence
		got := MinFailing(s, &ev)
		var enumEv Evidence
		failing := EnumerateAll(s, &enumEv)
		wantSize := MinSize(failing)
		gotSize := -1
		if got != nil {
			gotSize = len(got)
		}
		if gotSize != wantSize {
			t.Errorf("%s: search size %d != exhaustive minimum %d", name, gotSize, wantSize)
		}
		if len(enumEv.Checks) != 1<<uint(len(s.Events)) {
			t.Errorf("%s: enumeration checked %d, want %d", name, len(enumEv.Checks), 1<<uint(len(s.Events)))
		}
	}
}

// TestCrossCheckRandom generates deterministic random scenarios and
// cross-checks the search against exhaustive enumeration on each.
func TestCrossCheckRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	for trial := 0; trial < 200; trial++ {
		n := 2 + rng.Intn(9) // 2..10 events
		resources := []string{"r0", "r1", "r2", "r3"}
		s := Scenario{Name: fmt.Sprintf("rand-%d", trial), Target: fmt.Sprintf("e%d", n-1)}
		for i := 0; i < n; i++ {
			e := Event{ID: fmt.Sprintf("e%d", i)}
			for _, r := range resources {
				if rng.Intn(3) == 0 {
					e.Reads = append(e.Reads, r)
				}
				if rng.Intn(3) == 0 {
					e.Writes = append(e.Writes, r)
				}
			}
			s.Events = append(s.Events, e)
		}
		if err := s.Validate(); err != nil {
			t.Fatalf("trial %d: %v", trial, err)
		}
		var ev Evidence
		got := MinFailing(s, &ev)
		var enumEv Evidence
		wantSize := MinSize(EnumerateAll(s, &enumEv))
		gotSize := -1
		if got != nil {
			gotSize = len(got)
		}
		if gotSize != wantSize {
			t.Fatalf("trial %d: search size %d != exhaustive minimum %d (scenario %+v)",
				trial, gotSize, wantSize, s)
		}
		if got != nil && !IsOneMinimal(s, got) {
			t.Fatalf("trial %d: %v not 1-minimal", trial, got)
		}
	}
}

// TestEvidenceCompleteness ensures the search records every candidate it
// tests, in nondecreasing size order, stopping at the first failure.
func TestEvidenceCompleteness(t *testing.T) {
	s := scenarios["small"]
	var ev Evidence
	got := MinFailing(s, &ev)
	if got == nil {
		t.Fatal("expected a failing subsequence")
	}
	prevSize := 0
	for i, c := range ev.Checks {
		if len(c.Sub) < prevSize {
			t.Fatalf("check %d: size decreased (%d after %d)", i, len(c.Sub), prevSize)
		}
		prevSize = len(c.Sub)
		if c.Fail != (c.Legal && s.Fails(c.Sub)) {
			t.Fatalf("check %d: inconsistent verdict", i)
		}
	}
	last := ev.Checks[len(ev.Checks)-1]
	if !last.Fail {
		t.Fatal("search must stop exactly at the first failing candidate")
	}
	for _, c := range ev.Checks[:len(ev.Checks)-1] {
		if c.Fail {
			t.Fatal("an earlier candidate already failed; search should have stopped")
		}
	}
}
