// Package checker implements bounded and exact model checking for small
// finite state tables: shortest invariant-violating traces under a step
// budget, and fair liveness counterexamples (lassos) with SCC evidence.
//
// Limits (enforced on input): at most 8 states, at most 5 events, and a
// step budget of at most 10.
package checker

import (
	"errors"
	"fmt"
)

const (
	MaxStates = 8
	MaxEvents = 5
	MaxBudget = 10
)

// Transition is one row of the state table. Nondeterminism is allowed:
// the same (From, Event) pair may appear with several targets.
type Transition struct {
	From  string `json:"from"`
	Event string `json:"event"`
	To    string `json:"to"`
}

// Spec is the input state table. Event ID order is the order of Events;
// it is used to break ties between equally short counterexamples.
type Spec struct {
	States      []string     `json:"states"`
	Initial     string       `json:"initial"`
	Events      []string     `json:"events"`
	Transitions []Transition `json:"transitions"`
	Bad         []string     `json:"bad"`  // invariant: Bad states are unreachable
	Goal        []string     `json:"goal"` // liveness: Goal is visited infinitely often
	Budget      *int         `json:"budget,omitempty"`
}

// Model is a validated, indexed Spec.
type Model struct {
	Spec
	stateIdx map[string]int
	eventIdx map[string]int
	delta    [][][]int // delta[state][event] = target state indices, input order
	bad      []bool
	goal     []bool
}

// NewModel validates the spec and builds the transition table.
func NewModel(spec Spec) (*Model, error) {
	if len(spec.States) == 0 || len(spec.States) > MaxStates {
		return nil, fmt.Errorf("need 1..%d states, got %d", MaxStates, len(spec.States))
	}
	if len(spec.Events) == 0 || len(spec.Events) > MaxEvents {
		return nil, fmt.Errorf("need 1..%d events, got %d", MaxEvents, len(spec.Events))
	}
	m := &Model{
		Spec:     spec,
		stateIdx: make(map[string]int, len(spec.States)),
		eventIdx: make(map[string]int, len(spec.Events)),
		bad:      make([]bool, len(spec.States)),
		goal:     make([]bool, len(spec.States)),
	}
	for i, s := range spec.States {
		if s == "" {
			return nil, errors.New("state names must be non-empty")
		}
		if _, dup := m.stateIdx[s]; dup {
			return nil, fmt.Errorf("duplicate state %q", s)
		}
		m.stateIdx[s] = i
	}
	for i, e := range spec.Events {
		if e == "" {
			return nil, errors.New("event names must be non-empty")
		}
		if _, dup := m.eventIdx[e]; dup {
			return nil, fmt.Errorf("duplicate event %q", e)
		}
		m.eventIdx[e] = i
	}
	if _, ok := m.stateIdx[spec.Initial]; !ok {
		return nil, fmt.Errorf("initial state %q not declared", spec.Initial)
	}
	if spec.Budget != nil && (*spec.Budget < 0 || *spec.Budget > MaxBudget) {
		return nil, fmt.Errorf("budget must be 0..%d, got %d", MaxBudget, *spec.Budget)
	}
	m.delta = make([][][]int, len(spec.States))
	for i := range m.delta {
		m.delta[i] = make([][]int, len(spec.Events))
	}
	seen := make(map[[3]int]bool)
	for _, t := range spec.Transitions {
		from, ok := m.stateIdx[t.From]
		if !ok {
			return nil, fmt.Errorf("transition from unknown state %q", t.From)
		}
		ev, ok := m.eventIdx[t.Event]
		if !ok {
			return nil, fmt.Errorf("transition uses unknown event %q", t.Event)
		}
		to, ok := m.stateIdx[t.To]
		if !ok {
			return nil, fmt.Errorf("transition to unknown state %q", t.To)
		}
		key := [3]int{from, ev, to}
		if seen[key] {
			continue
		}
		seen[key] = true
		m.delta[from][ev] = append(m.delta[from][ev], to)
	}
	for _, b := range spec.Bad {
		i, ok := m.stateIdx[b]
		if !ok {
			return nil, fmt.Errorf("bad state %q not declared", b)
		}
		m.bad[i] = true
	}
	for _, g := range spec.Goal {
		i, ok := m.stateIdx[g]
		if !ok {
			return nil, fmt.Errorf("goal state %q not declared", g)
		}
		m.goal[i] = true
	}
	return m, nil
}

func (m *Model) NumStates() int { return len(m.Spec.States) }
func (m *Model) NumEvents() int { return len(m.Spec.Events) }

// StepBudget resolves the effective step budget (default MaxBudget).
func (m *Model) StepBudget() int {
	if m.Spec.Budget != nil {
		return *m.Spec.Budget
	}
	return MaxBudget
}

func (m *Model) InitState() int { return m.stateIdx[m.Spec.Initial] }

// Targets returns the targets of (state, event) in input order.
func (m *Model) Targets(state, event int) []int { return m.delta[state][event] }

func (m *Model) IsBad(s int) bool  { return m.bad[s] }
func (m *Model) IsGoal(s int) bool { return m.goal[s] }

// EnabledEvents lists the events enabled at s, in event ID order.
func (m *Model) EnabledEvents(s int) []int {
	var out []int
	for e := range m.Spec.Events {
		if len(m.delta[s][e]) > 0 {
			out = append(out, e)
		}
	}
	return out
}

// Trace is a finite path: len(States) == len(Events)+1.
type Trace struct {
	States []string `json:"states"`
	Events []string `json:"events"`
}
