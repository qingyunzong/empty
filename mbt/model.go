// Package mbt implements model-based testing of a protocol implementation
// against a finite state table.
package mbt

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// Transition is one row of the protocol state table.
type Transition struct {
	From   string `json:"from"`
	Action string `json:"action"`
	To     string `json:"to"`
}

// State describes an observable protocol state and its expected data.
type State struct {
	Data map[string]any `json:"data,omitempty"`
}

// Model is a finite protocol state table.
type Model struct {
	Initial     string           `json:"initial"`
	States      map[string]State `json:"states"`
	Transitions []Transition     `json:"transitions"`
}

// LoadModel reads and validates a state table from a JSON file.
func LoadModel(path string) (*Model, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var m Model
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("parse model: %w", err)
	}
	if m.Initial == "" {
		return nil, fmt.Errorf("model: initial state is required")
	}
	if m.States == nil {
		m.States = map[string]State{}
	}
	if _, ok := m.States[m.Initial]; !ok {
		m.States[m.Initial] = State{}
	}
	seen := map[Transition]bool{}
	for _, t := range m.Transitions {
		if t.From == "" || t.To == "" || t.Action == "" {
			return nil, fmt.Errorf("model: transition %+v has empty field", t)
		}
		if _, ok := m.States[t.From]; !ok {
			return nil, fmt.Errorf("model: unknown from-state %q", t.From)
		}
		if _, ok := m.States[t.To]; !ok {
			return nil, fmt.Errorf("model: unknown to-state %q", t.To)
		}
		if seen[t] {
			return nil, fmt.Errorf("model: duplicate transition %+v", t)
		}
		seen[t] = true
	}
	return &m, nil
}

// Actions returns the sorted set of action names used by the table.
func (m *Model) Actions() []string {
	set := map[string]bool{}
	for _, t := range m.Transitions {
		set[t.Action] = true
	}
	out := make([]string, 0, len(set))
	for a := range set {
		out = append(out, a)
	}
	sort.Strings(out)
	return out
}

// LegalFrom returns transitions originating at state s, sorted by action.
func (m *Model) LegalFrom(s string) []Transition {
	var out []Transition
	for _, t := range m.Transitions {
		if t.From == s {
			out = append(out, t)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Action < out[j].Action })
	return out
}

// IllegalFrom returns actions of the table that are NOT legal from state s.
func (m *Model) IllegalFrom(s string) []string {
	legal := map[string]bool{}
	for _, t := range m.Transitions {
		if t.From == s {
			legal[t.Action] = true
		}
	}
	var out []string
	for _, a := range m.Actions() {
		if !legal[a] {
			out = append(out, a)
		}
	}
	return out
}
