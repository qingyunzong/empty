package main

import (
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

// smallExample mirrors examples/small.json. Victim e5 fails when it reads
// x last-written by e2. Keeping e2 plus the writers needed for legality
// gives the minimal failing subsequence [e2 e4 e5].
func smallExample() *Scenario {
	return &Scenario{
		Name: "small",
		Events: []Event{
			ev("e1", nil, []string{"x"}),
			ev("e2", nil, []string{"x"}),
			ev("e3", nil, []string{"y"}),
			ev("e4", []string{"x"}, []string{"z"}),
			ev("e5", []string{"z", "x"}, nil),
		},
		Fail: map[string][]string{"x": {"e2"}},
	}
}

func TestMinimizeSmallExample(t *testing.T) {
	s := smallExample()
	mustValidate(t, s)
	res := Minimize(s)
	if !res.Found {
		t.Fatal("expected a failing subsequence")
	}
	if res.MinimalSize != 3 {
		t.Fatalf("minimal size = %d, want 3", res.MinimalSize)
	}
	if got := res.Witness; !reflect.DeepEqual(got, []int{1, 3, 4}) {
		t.Fatalf("witness = %v, want [1 3 4] (e2 e4 e5)", got)
	}
	if res.MinimalCount != 1 {
		t.Fatalf("minimal failing count = %d, want 1", res.MinimalCount)
	}
	total := 0
	for _, st := range res.Stats {
		total += st.Total
		if st.Size < res.MinimalSize && st.Failing != 0 {
			t.Fatalf("size %d has %d failing, contradicts minimality", st.Size, st.Failing)
		}
	}
	// Search stopped at size 3: sizes 0..3 => 1+5+10+10 = 26 checked.
	if total != 26 {
		t.Fatalf("checked %d subsequences, want 26", total)
	}
	if res.LegalBelowMin == 0 {
		t.Fatal("expected some legal subsequences below the minimal size")
	}
}

// TestIllegalSubsequenceNotFailure: [e2 e3] would make the victim observe
// bad writer e2, but it is illegal (e2 reads y with no prior write) and
// must not count; the true minimum is the legal [e0 e2 e3].
func TestIllegalSubsequenceNotFailure(t *testing.T) {
	s := &Scenario{
		Events: []Event{
			ev("e0", nil, []string{"y"}),
			ev("e1", nil, []string{"x"}),
			ev("e2", []string{"y"}, []string{"x"}),
			ev("e3", []string{"x"}, nil),
		},
		Fail: map[string][]string{"x": {"e2"}},
	}
	mustValidate(t, s)
	if fails, tr := s.fails([]int{2, 3}); fails || tr.legal {
		t.Fatal("[e2 e3] is illegal and must not count as failure")
	}
	res := Minimize(s)
	if !res.Found || res.MinimalSize != 3 {
		t.Fatalf("minimal size = %d, want 3 (illegal size-2 must be excluded)", res.MinimalSize)
	}
	if got := res.Witness; !reflect.DeepEqual(got, []int{0, 2, 3}) {
		t.Fatalf("witness = %v, want [0 2 3] (e0 e2 e3)", got)
	}
}

func TestEnumerateCoversAllSubsequences(t *testing.T) {
	s := smallExample()
	mustValidate(t, s)
	rows := Enumerate(s)
	if len(rows) != 1<<5 {
		t.Fatalf("Enumerate returned %d rows, want %d", len(rows), 1<<5)
	}
	failing := 0
	for _, r := range rows {
		if r.Failing {
			failing++
			if !r.Legal {
				t.Fatalf("row %v marked failing but illegal", r.Indices)
			}
		}
	}
	if failing == 0 {
		t.Fatal("expected at least one failing row (the full sequence)")
	}
}

// bruteForceMin is an independent bitmask enumeration used to cross-check
// Minimize on small examples.
func bruteForceMin(s *Scenario) (size int, count int, found bool) {
	n := len(s.Events)
	best := -1
	for mask := 0; mask < (1 << n); mask++ {
		var idx []int
		for i := 0; i < n; i++ {
			if mask&(1<<i) != 0 {
				idx = append(idx, i)
			}
		}
		if fails, _ := s.fails(idx); fails {
			if best == -1 || len(idx) < best {
				best, count = len(idx), 1
			} else if len(idx) == best {
				count++
			}
		}
	}
	return best, count, best >= 0
}

// TestMinimizeCrossCheck enumerates ALL subsequences of many small random
// scenarios and verifies Minimize returns the true minimum size and count.
func TestMinimizeCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	resources := []string{"x", "y", "z"}
	valid := 0
	for attempt := 0; attempt < 200000 && valid < 300; attempt++ {
		n := 1 + rng.Intn(8) // 1..8 events
		evs := make([]Event, n)
		ids := make([]string, n)
		for i := range evs {
			ids[i] = string(rune('a' + i))
			e := Event{ID: ids[i]}
			for _, r := range resources {
				if rng.Intn(2) == 0 {
					e.Writes = append(e.Writes, r)
				}
				if rng.Intn(3) == 0 {
					e.Reads = append(e.Reads, r)
				}
			}
			evs[i] = e
		}
		s := &Scenario{Events: evs}
		// Random fail oracle: one resource, 1-2 bad writers.
		bad := map[string][]string{}
		r := resources[rng.Intn(len(resources))]
		for k := 1 + rng.Intn(2); k > 0; k-- {
			w := ids[rng.Intn(n)]
			dup := false
			for _, b := range bad[r] {
				if b == w {
					dup = true
				}
			}
			if !dup {
				bad[r] = append(bad[r], w)
			}
		}
		s.Fail = bad
		if err := s.Validate(); err != nil {
			continue // need legal, failing full sequence
		}
		valid++
		res := Minimize(s)
		size, count, found := bruteForceMin(s)
		if res.Found != found {
			t.Fatalf("scenario %d: found mismatch (%v vs %v)", valid, res.Found, found)
		}
		if !found {
			t.Fatalf("scenario %d: validated scenario must have a failing subsequence", valid)
		}
		if res.MinimalSize != size {
			t.Fatalf("scenario %d: minimal size %d, brute force says %d (events %+v)",
				valid, res.MinimalSize, size, evs)
		}
		if res.MinimalCount != count {
			t.Fatalf("scenario %d: minimal count %d, brute force says %d", valid, res.MinimalCount, count)
		}
		if len(res.Witness) != size {
			t.Fatalf("scenario %d: witness size %d, want %d", valid, len(res.Witness), size)
		}
		if fails, _ := s.fails(res.Witness); !fails {
			t.Fatalf("scenario %d: witness %v does not fail", valid, res.Witness)
		}
	}
	if valid < 100 {
		t.Fatalf("only %d valid random scenarios, want >= 100 for a meaningful cross-check", valid)
	}
	t.Logf("cross-checked %d random scenarios against brute force", valid)
}

func TestRunPrintsEvidence(t *testing.T) {
	s := smallExample()
	mustValidate(t, s)
	var buf strings.Builder
	code := run(s, true, &buf)
	if code != 0 {
		t.Fatalf("run exit code = %d, want 0", code)
	}
	out := buf.String()
	for _, want := range []string{
		`scenario "small": 5 events, victim e5`,
		"full sequence [e1 e2 e3 e4 e5]: legal=true fails=true",
		"minimal failing subsequence (size 3): [e2 e4 e5]",
		"legality trace",
		"declared bad",
		"minimality:",
		"full enumeration evidence (32 subsequences)",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q", want)
		}
	}
}
