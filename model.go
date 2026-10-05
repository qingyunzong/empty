package main

import (
	"fmt"
	"sort"
	"strings"
)

// Event declares the resources it reads and writes.
type Event struct {
	ID     string
	Reads  []string
	Writes []string
}

// Scenario is an ordered event list plus the failure predicate parameters.
type Scenario struct {
	Name    string
	Events  []Event
	Initial []string // resources available before any event runs
	Target  string   // ID of the event whose presence (legally) means failure
}

// MaxEvents is the hard cap on scenario size.
const MaxEvents = 20

// Validate checks structural constraints of a scenario.
func (s Scenario) Validate() error {
	if len(s.Events) == 0 {
		return fmt.Errorf("scenario %q: no events", s.Name)
	}
	if len(s.Events) > MaxEvents {
		return fmt.Errorf("scenario %q: %d events exceeds cap %d", s.Name, len(s.Events), MaxEvents)
	}
	seen := map[string]bool{}
	targetOK := false
	for _, e := range s.Events {
		if e.ID == "" {
			return fmt.Errorf("scenario %q: event with empty ID", s.Name)
		}
		if seen[e.ID] {
			return fmt.Errorf("scenario %q: duplicate event ID %q", s.Name, e.ID)
		}
		seen[e.ID] = true
		if e.ID == s.Target {
			targetOK = true
		}
	}
	if !targetOK {
		return fmt.Errorf("scenario %q: target event %q not found", s.Name, s.Target)
	}
	return nil
}

// Legal reports whether the subsequence (indices into Events, ascending)
// satisfies the read-after-write prerequisite check: every read resource
// must be Initial or written by some earlier kept event.
func (s Scenario) Legal(sub []int) bool {
	available := map[string]bool{}
	for _, r := range s.Initial {
		available[r] = true
	}
	for _, i := range sub {
		for _, r := range s.Events[i].Reads {
			if !available[r] {
				return false
			}
		}
		for _, w := range s.Events[i].Writes {
			available[w] = true
		}
	}
	return true
}

// Fails reports whether the subsequence reproduces the failure:
// it must be legal (illegal subsequences never count as failures)
// and must contain the target event.
func (s Scenario) Fails(sub []int) bool {
	hasTarget := false
	for _, i := range sub {
		if s.Events[i].ID == s.Target {
			hasTarget = true
			break
		}
	}
	return hasTarget && s.Legal(sub)
}

// SubIDs renders a subsequence as event IDs for evidence output.
func (s Scenario) SubIDs(sub []int) string {
	ids := make([]string, len(sub))
	for k, i := range sub {
		ids[k] = s.Events[i].ID
	}
	return "[" + strings.Join(ids, " ") + "]"
}

// sortedStrings is a small helper for deterministic scenario definitions.
func sortedStrings(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
