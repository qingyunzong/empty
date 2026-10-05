// Package statever verifies invariant properties of finite state tables.
//
// Limits (enforced on load): at most 8 states, at most 5 events, and a
// search budget of at most 10 steps.
package statever

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
)

const (
	MaxStates = 8
	MaxEvents = 5
	MaxBudget = 10
)

// Transition is one row of the state table.
type Transition struct {
	From  string `json:"from"`
	Event string `json:"event"`
	To    string `json:"to"`
}

// spec is the JSON wire format.
type spec struct {
	States      []string     `json:"states"`
	Initial     string       `json:"initial"`
	Events      []string     `json:"events"` // input order defines event ID order
	Transitions []Transition `json:"transitions"`
	Bad         []string     `json:"bad"` // states violating the invariant
	Budget      int          `json:"budget"`
}

// Model is a validated, indexed state table.
type Model struct {
	States  []string
	Initial string
	Events  []string // ID order: Events[0] < Events[1] < ...
	Bad     map[string]bool
	Budget  int

	stateIdx map[string]int
	eventIdx map[string]int
	// adj[s][e] lists destination state indices for (state, event).
	adj [][][]int
}

// ParseModel reads and validates a state table, enforcing the hard limits
// of at most 8 states, 5 events and a 10-step budget.
func ParseModel(r io.Reader) (*Model, error) {
	var sp spec
	dec := json.NewDecoder(r)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&sp); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if len(sp.States) == 0 {
		return nil, fmt.Errorf("states must be non-empty")
	}
	if len(sp.States) > MaxStates {
		return nil, fmt.Errorf("too many states: %d > %d", len(sp.States), MaxStates)
	}
	if len(sp.Events) == 0 {
		return nil, fmt.Errorf("events must be non-empty")
	}
	if len(sp.Events) > MaxEvents {
		return nil, fmt.Errorf("too many events: %d > %d", len(sp.Events), MaxEvents)
	}
	if sp.Budget == 0 {
		sp.Budget = MaxBudget
	}
	if sp.Budget < 0 || sp.Budget > MaxBudget {
		return nil, fmt.Errorf("budget %d out of range [0,%d]", sp.Budget, MaxBudget)
	}

	m := &Model{
		States:   sp.States,
		Initial:  sp.Initial,
		Events:   sp.Events,
		Bad:      map[string]bool{},
		Budget:   sp.Budget,
		stateIdx: map[string]int{},
		eventIdx: map[string]int{},
	}
	for i, s := range sp.States {
		if _, dup := m.stateIdx[s]; dup {
			return nil, fmt.Errorf("duplicate state %q", s)
		}
		m.stateIdx[s] = i
	}
	for i, e := range sp.Events {
		if _, dup := m.eventIdx[e]; dup {
			return nil, fmt.Errorf("duplicate event %q", e)
		}
		m.eventIdx[e] = i
	}
	if _, ok := m.stateIdx[sp.Initial]; !ok {
		return nil, fmt.Errorf("initial state %q not declared", sp.Initial)
	}
	for _, b := range sp.Bad {
		if _, ok := m.stateIdx[b]; !ok {
			return nil, fmt.Errorf("bad state %q not declared", b)
		}
		m.Bad[b] = true
	}

	m.adj = make([][][]int, len(sp.States))
	for i := range m.adj {
		m.adj[i] = make([][]int, len(sp.Events))
	}
	for _, t := range sp.Transitions {
		si, ok := m.stateIdx[t.From]
		if !ok {
			return nil, fmt.Errorf("transition from undeclared state %q", t.From)
		}
		ei, ok := m.eventIdx[t.Event]
		if !ok {
			return nil, fmt.Errorf("transition with undeclared event %q", t.Event)
		}
		di, ok := m.stateIdx[t.To]
		if !ok {
			return nil, fmt.Errorf("transition to undeclared state %q", t.To)
		}
		m.adj[si][ei] = append(m.adj[si][ei], di)
	}
	// Deterministic successor order independent of input row order.
	for si := range m.adj {
		for ei := range m.adj[si] {
			sort.Ints(m.adj[si][ei])
		}
	}
	return m, nil
}

// StateName returns the name of state index i.
func (m *Model) StateName(i int) string { return m.States[i] }

// EventName returns the name (ID) of event index i.
func (m *Model) EventName(i int) string { return m.Events[i] }

// InitialIndex returns the index of the initial state.
func (m *Model) InitialIndex() int { return m.stateIdx[m.Initial] }

// IsBad reports whether state index i violates the invariant.
func (m *Model) IsBad(i int) bool { return m.Bad[m.States[i]] }

// NumStates returns the number of states.
func (m *Model) NumStates() int { return len(m.States) }

// NumEvents returns the number of events.
func (m *Model) NumEvents() int { return len(m.Events) }

// Next returns the destination indices of (state, event), in state order.
func (m *Model) Next(state, event int) []int { return m.adj[state][event] }

// Enabled reports whether the event has any outgoing transition at state.
func (m *Model) Enabled(state, event int) bool { return len(m.adj[state][event]) > 0 }
