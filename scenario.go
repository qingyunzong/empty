package main

import (
	"encoding/json"
	"fmt"
	"os"
)

// MaxEvents bounds the scenario size so that exhaustive
// enumeration over all 2^n subsequences stays feasible.
const MaxEvents = 20

// Event declares the resources it reads and writes.
type Event struct {
	ID     string   `json:"id"`
	Reads  []string `json:"reads"`
	Writes []string `json:"writes"`
}

// Scenario is an ordered list of events plus a failure oracle.
// Victim is the event whose reads are checked (default: last event).
// Fail maps a resource to the set of "bad" writer event ids: the
// scenario fails when the victim reads a resource whose last writer
// (within the retained subsequence) is a declared bad writer.
type Scenario struct {
	Name   string              `json:"name"`
	Victim string              `json:"victim"`
	Events []Event             `json:"events"`
	Fail   map[string][]string `json:"fail"`
}

// LoadScenario reads and validates a scenario file.
func LoadScenario(path string) (*Scenario, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s Scenario
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := s.Validate(); err != nil {
		return nil, fmt.Errorf("invalid scenario %s: %w", path, err)
	}
	return &s, nil
}

// Validate checks structural constraints and that the full sequence
// is legal and fails (otherwise there is nothing to minimize).
func (s *Scenario) Validate() error {
	if len(s.Events) == 0 {
		return fmt.Errorf("no events")
	}
	if len(s.Events) > MaxEvents {
		return fmt.Errorf("too many events: %d > %d", len(s.Events), MaxEvents)
	}
	seen := map[string]bool{}
	for _, ev := range s.Events {
		if ev.ID == "" {
			return fmt.Errorf("event with empty id")
		}
		if seen[ev.ID] {
			return fmt.Errorf("duplicate event id %q", ev.ID)
		}
		seen[ev.ID] = true
	}
	if s.Victim == "" {
		s.Victim = s.Events[len(s.Events)-1].ID
	}
	if s.victimIndex() < 0 {
		return fmt.Errorf("victim %q is not an event", s.Victim)
	}
	if len(s.Fail) == 0 {
		return fmt.Errorf("no fail oracle declared")
	}
	for resource, writers := range s.Fail {
		if len(writers) == 0 {
			return fmt.Errorf("fail oracle for %q lists no bad writers", resource)
		}
		for _, w := range writers {
			if !seen[w] {
				return fmt.Errorf("fail oracle for %q names unknown event %q", resource, w)
			}
		}
	}
	full := simulate(s.Events, allIndices(len(s.Events)))
	if !full.legal {
		return fmt.Errorf("full sequence is illegal: %s", full.violation)
	}
	if fails, _ := s.fails(allIndices(len(s.Events))); !fails {
		return fmt.Errorf("full sequence does not fail; nothing to minimize")
	}
	return nil
}

func (s *Scenario) victimIndex() int {
	for i, ev := range s.Events {
		if ev.ID == s.Victim {
			return i
		}
	}
	return -1
}

func (s *Scenario) badWriter(resource, writer string) bool {
	for _, w := range s.Fail[resource] {
		if w == writer {
			return true
		}
	}
	return false
}

func allIndices(n int) []int {
	idx := make([]int, n)
	for i := range idx {
		idx[i] = i
	}
	return idx
}

// readBinding records which event's write a read observed.
type readBinding struct {
	eventID  string
	resource string
	writer   string
}

// trace is the result of simulating one subsequence.
type trace struct {
	legal     bool
	violation string // first precondition violation, if illegal
	bindings  []readBinding
}

// simulate replays the subsequence events[idx...] in order, checking the
// precondition that every read resource was written earlier in the
// subsequence, and recording the last writer observed by each read.
func simulate(events []Event, idx []int) trace {
	written := map[string]bool{}
	lastWriter := map[string]string{}
	tr := trace{legal: true}
	for _, i := range idx {
		ev := events[i]
		for _, r := range ev.Reads {
			if !written[r] {
				tr.legal = false
				tr.violation = fmt.Sprintf("event %s reads %q with no prior write in the subsequence", ev.ID, r)
				return tr
			}
			tr.bindings = append(tr.bindings, readBinding{eventID: ev.ID, resource: r, writer: lastWriter[r]})
		}
		for _, w := range ev.Writes {
			written[w] = true
			lastWriter[w] = ev.ID
		}
	}
	return tr
}

// observation extracts the last-writer mapping seen by the victim's reads.
func observation(tr trace, victimID string) map[string]string {
	obs := map[string]string{}
	for _, b := range tr.bindings {
		if b.eventID == victimID {
			obs[b.resource] = b.writer
		}
	}
	return obs
}

// fails reports whether the subsequence reproduces the failure: it must be
// legal (illegal subsequences never count), contain the victim, and the
// victim must read at least one resource whose last writer within the
// subsequence is a declared bad writer for that resource.
func (s *Scenario) fails(idx []int) (bool, trace) {
	tr := simulate(s.Events, idx)
	if !tr.legal {
		return false, tr
	}
	vi := s.victimIndex()
	contained := false
	for _, i := range idx {
		if i == vi {
			contained = true
			break
		}
	}
	if !contained {
		return false, tr
	}
	for resource, writer := range observation(tr, s.Victim) {
		if s.badWriter(resource, writer) {
			return true, tr
		}
	}
	return false, tr
}
