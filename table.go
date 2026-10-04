// Package protocol implements a session protocol library whose actions are
// authorized by a public finite state table. Every state transition is
// persisted to a journal before it is returned to the caller, idempotency
// keys bind to a single action, and expired sessions reject transitions.
package protocol

// Edge identifies one cell of the finite state table: an action attempted
// in a given state.
type Edge struct {
	State  string
	Action string
}

// Table is the public finite state table that authorizes actions. A
// transition from state S under action A is authorized iff
// Transitions[Edge{S, A}] exists, in which case its value is the next state.
type Table struct {
	Initial     string
	Transitions map[Edge]string
}

// Step reports the next state for (state, action) and whether the table
// authorizes the transition.
func (t *Table) Step(state, action string) (string, bool) {
	next, ok := t.Transitions[Edge{State: state, Action: action}]
	return next, ok
}

// Transition records one applied step of the serial interpreter.
type Transition struct {
	Action string
	From   string
	To     string
}

// Interpreter is the serial table interpreter: a reference implementation
// that applies actions to the table one at a time, in memory, with no
// persistence, idempotency, or expiry concerns. Crash-recovery tests
// compare the durable Machine against it.
type Interpreter struct {
	table   *Table
	state   string
	history []Transition
}

// NewInterpreter returns an Interpreter positioned at the table's initial
// state.
func NewInterpreter(t *Table) *Interpreter {
	return &Interpreter{table: t, state: t.Initial}
}

// State returns the interpreter's current state.
func (i *Interpreter) State() string { return i.state }

// History returns the transitions applied so far, in order.
func (i *Interpreter) History() []Transition {
	return append([]Transition(nil), i.history...)
}

// Apply serially applies one action through the table.
func (i *Interpreter) Apply(action string) (string, error) {
	next, ok := i.table.Step(i.state, action)
	if !ok {
		return i.state, ErrActionNotAuthorized
	}
	i.history = append(i.history, Transition{Action: action, From: i.state, To: next})
	i.state = next
	return next, nil
}
