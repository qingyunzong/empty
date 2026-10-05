package main

import (
	"strings"
	"testing"
)

func ev(id string, reads, writes []string) Event {
	return Event{ID: id, Reads: reads, Writes: writes}
}

func mustValidate(t *testing.T, s *Scenario) {
	t.Helper()
	if err := s.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

func TestSimulateLegality(t *testing.T) {
	events := []Event{
		ev("e1", nil, []string{"x"}),
		ev("e2", []string{"x"}, nil),
		ev("e3", []string{"y"}, nil),
	}
	if tr := simulate(events, []int{0, 1}); !tr.legal {
		t.Fatalf("expected legal, got violation %q", tr.violation)
	}
	tr := simulate(events, []int{1})
	if tr.legal {
		t.Fatal("expected illegal: e2 reads x with no prior write")
	}
	if !strings.Contains(tr.violation, "e2") || !strings.Contains(tr.violation, `"x"`) {
		t.Fatalf("violation should name event and resource, got %q", tr.violation)
	}
	tr = simulate(events, []int{0, 1, 2})
	if tr.legal {
		t.Fatal("expected illegal: e3 reads y never written")
	}
}

func TestSimulateRecordsLastWriter(t *testing.T) {
	events := []Event{
		ev("e1", nil, []string{"x"}),
		ev("e2", nil, []string{"x"}),
		ev("e3", []string{"x"}, nil),
	}
	tr := simulate(events, []int{0, 1, 2})
	if !tr.legal {
		t.Fatalf("expected legal, got %q", tr.violation)
	}
	if obs := observation(tr, "e3"); obs["x"] != "e2" {
		t.Fatalf("last writer of x = %q, want e2", obs["x"])
	}
	// Deleting e2 changes the observed writer.
	tr = simulate(events, []int{0, 2})
	if obs := observation(tr, "e3"); obs["x"] != "e1" {
		t.Fatalf("last writer of x = %q, want e1", obs["x"])
	}
}

func TestValidateDefaultsVictimToLastEvent(t *testing.T) {
	s := &Scenario{
		Events: []Event{
			ev("e1", nil, []string{"x"}),
			ev("e2", nil, []string{"x"}),
			ev("e3", []string{"x"}, nil),
		},
		Fail: map[string][]string{"x": {"e2"}},
	}
	mustValidate(t, s)
	if s.Victim != "e3" {
		t.Fatalf("default victim = %q, want e3", s.Victim)
	}
}

func TestValidateRejectsBadScenarios(t *testing.T) {
	cases := map[string]*Scenario{
		"no events": {},
		"too many events": {Events: func() []Event {
			evs := make([]Event, MaxEvents+1)
			for i := range evs {
				evs[i] = Event{ID: strings.Repeat("e", i+1)}
			}
			return evs
		}()},
		"duplicate id": {Events: []Event{
			ev("e1", nil, []string{"x"}),
			ev("e1", nil, []string{"x"}),
		}},
		"unknown victim": {Victim: "nope", Events: []Event{
			ev("e1", nil, []string{"x"}),
		}},
		"no fail oracle": {Events: []Event{
			ev("e1", nil, []string{"x"}),
			ev("e2", []string{"x"}, nil),
		}},
		"empty bad writers": {
			Events: []Event{ev("e1", nil, []string{"x"}), ev("e2", []string{"x"}, nil)},
			Fail:   map[string][]string{"x": {}},
		},
		"unknown bad writer": {
			Events: []Event{ev("e1", nil, []string{"x"}), ev("e2", []string{"x"}, nil)},
			Fail:   map[string][]string{"x": {"ghost"}},
		},
		"illegal full sequence": {
			Events: []Event{ev("e1", []string{"x"}, nil)},
			Fail:   map[string][]string{"x": {"e1"}},
		},
		"full sequence passes": {
			Events: []Event{
				ev("e1", nil, []string{"x"}),
				ev("e2", nil, []string{"x"}),
				ev("e3", []string{"x"}, nil),
			},
			Fail: map[string][]string{"x": {"e1"}}, // full sequence observes e2
		},
	}
	for name, s := range cases {
		if err := s.Validate(); err == nil {
			t.Errorf("%s: expected validation error, got nil", name)
		}
	}
}

func TestFailsSemantics(t *testing.T) {
	s := &Scenario{
		Events: []Event{
			ev("e1", nil, []string{"x"}),
			ev("e2", nil, []string{"x"}),
			ev("e3", []string{"x"}, nil),
		},
		Fail: map[string][]string{"x": {"e2"}},
	}
	mustValidate(t, s)

	if fails, _ := s.fails([]int{0, 1, 2}); !fails {
		t.Error("full sequence should fail: victim sees bad writer e2")
	}
	if fails, _ := s.fails([]int{1, 2}); !fails {
		t.Error("[e2 e3] should fail: victim sees bad writer e2")
	}
	if fails, _ := s.fails([]int{0, 2}); fails {
		t.Error("[e1 e3] should pass: victim sees e1, not a bad writer")
	}
	if fails, tr := s.fails([]int{2}); fails || tr.legal {
		t.Error("[e3] is illegal and must not count as failure")
	}
	if fails, _ := s.fails([]int{0, 1}); fails {
		t.Error("subsequence without victim must not fail")
	}
	if fails, _ := s.fails(nil); fails {
		t.Error("empty subsequence must not fail")
	}
}
