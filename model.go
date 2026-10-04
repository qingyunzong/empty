package protocheck

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// Transition is one edge of the protocol state machine.
type Transition struct {
	Action string `json:"action"`
	From   string `json:"from"`
	To     string `json:"to"`
}

// Table is a finite protocol state table.
type Table struct {
	Initial     string       `json:"initial"`
	States      []string     `json:"states"`
	Transitions []Transition `json:"transitions"`

	byFrom map[string]map[string]string
}

// LoadTable reads and validates a JSON state table.
func LoadTable(path string) (*Table, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var t Table
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := t.Validate(); err != nil {
		return nil, fmt.Errorf("invalid table %s: %w", path, err)
	}
	return &t, nil
}

// Validate checks that the table is a deterministic finite machine.
func (t *Table) Validate() error {
	states := map[string]bool{}
	for _, s := range t.States {
		states[s] = true
	}
	if !states[t.Initial] {
		return fmt.Errorf("initial state %q not in states", t.Initial)
	}
	seen := map[string]map[string]bool{}
	for _, tr := range t.Transitions {
		if tr.Action == "" {
			return fmt.Errorf("transition with empty action")
		}
		if !states[tr.From] {
			return fmt.Errorf("transition from unknown state %q", tr.From)
		}
		if !states[tr.To] {
			return fmt.Errorf("transition to unknown state %q", tr.To)
		}
		if seen[tr.From][tr.Action] {
			return fmt.Errorf("duplicate transition for (%q, %q)", tr.From, tr.Action)
		}
		if seen[tr.From] == nil {
			seen[tr.From] = map[string]bool{}
		}
		seen[tr.From][tr.Action] = true
	}
	return nil
}

// HasState reports whether s is a declared state.
func (t *Table) HasState(s string) bool {
	for _, x := range t.States {
		if x == s {
			return true
		}
	}
	return false
}

func (t *Table) index() map[string]map[string]string {
	if t.byFrom == nil {
		t.byFrom = map[string]map[string]string{}
		for _, tr := range t.Transitions {
			if t.byFrom[tr.From] == nil {
				t.byFrom[tr.From] = map[string]string{}
			}
			t.byFrom[tr.From][tr.Action] = tr.To
		}
	}
	return t.byFrom
}

// Step returns the target state of action from state, or ok=false if illegal.
func (t *Table) Step(state, action string) (to string, ok bool) {
	to, ok = t.index()[state][action]
	return to, ok
}

// LegalActions lists the actions legal in state, sorted for determinism.
func (t *Table) LegalActions(state string) []string {
	var out []string
	for a := range t.index()[state] {
		out = append(out, a)
	}
	sort.Strings(out)
	return out
}

// Actions lists the full action alphabet of the table, sorted.
func (t *Table) Actions() []string {
	set := map[string]bool{}
	for _, tr := range t.Transitions {
		set[tr.Action] = true
	}
	out := make([]string, 0, len(set))
	for a := range set {
		out = append(out, a)
	}
	sort.Strings(out)
	return out
}

// GenerateHistories enumerates every legal action history of length 0..n
// starting from the initial state, in BFS (shortest-first) order.
func (t *Table) GenerateHistories(n int) [][]string {
	type node struct {
		state string
		hist  []string
	}
	out := [][]string{{}}
	queue := []node{{state: t.Initial}}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if len(cur.hist) >= n {
			continue
		}
		for _, act := range t.LegalActions(cur.state) {
			next, _ := t.Step(cur.state, act)
			h := append(append([]string{}, cur.hist...), act)
			out = append(out, h)
			queue = append(queue, node{state: next, hist: h})
		}
	}
	return out
}
