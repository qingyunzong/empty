// Package fsm implements a protocol library that authorizes actions against
// a public finite state table, persists every state transition record before
// returning, binds idempotency keys to a single action, and rejects
// transitions on expired sessions.
package fsm

import "fmt"

// State is a node of the finite state machine.
type State string

// Action is an edge label of the finite state machine.
type Action string

// Transition authorizes moving From one state To another via Action.
type Transition struct {
	From   State
	Action Action
	To     State
}

// Table is a public finite state table. Callers build it, inspect it via
// Transitions, and the Engine authorizes every action against it.
type Table struct {
	initial State
	byState map[State]map[Action]State
	list    []Transition
}

// NewTable builds a Table with the given initial state and transitions.
// It rejects empty fields and duplicate (From, Action) pairs.
func NewTable(initial State, ts []Transition) (*Table, error) {
	if initial == "" {
		return nil, fmt.Errorf("fsm: empty initial state")
	}
	t := &Table{initial: initial, byState: make(map[State]map[Action]State)}
	for _, tr := range ts {
		if tr.From == "" || tr.Action == "" || tr.To == "" {
			return nil, fmt.Errorf("fsm: invalid transition %+v", tr)
		}
		m, ok := t.byState[tr.From]
		if !ok {
			m = make(map[Action]State)
			t.byState[tr.From] = m
		}
		if _, dup := m[tr.Action]; dup {
			return nil, fmt.Errorf("fsm: duplicate transition (%q, %q)", tr.From, tr.Action)
		}
		m[tr.Action] = tr.To
		t.list = append(t.list, tr)
	}
	return t, nil
}

// Initial returns the state every new session starts in.
func (t *Table) Initial() State { return t.initial }

// Lookup reports whether the table authorizes action a from state from,
// and if so the resulting state.
func (t *Table) Lookup(from State, a Action) (to State, ok bool) {
	if m, ok := t.byState[from]; ok {
		to, ok = m[a]
		return to, ok
	}
	return "", false
}

// Transitions returns a copy of the public transition list, in the order
// the table was defined.
func (t *Table) Transitions() []Transition {
	out := make([]Transition, len(t.list))
	copy(out, t.list)
	return out
}
