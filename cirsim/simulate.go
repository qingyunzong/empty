package cirsim

import (
	"fmt"
	"strings"
)

// Kind classifies the outcome of a simulation run.
type Kind int

const (
	// Converged: a round produced no change; State holds the stable values.
	Converged Kind = iota
	// Cycle: a state repeated an earlier state; State is the witness at the
	// moment of detection and Period is the cycle length in rounds.
	Cycle
	// Undecided: the round budget was exhausted first.
	Undecided
)

func (k Kind) String() string {
	switch k {
	case Converged:
		return "converged"
	case Cycle:
		return "cycle"
	default:
		return "undecided"
	}
}

// Result is the outcome of Simulate.
type Result struct {
	Kind   Kind
	State  []Value // stable values (Converged) or cycle witness (Cycle)
	Period int     // cycle length in rounds (Cycle only)
	Rounds int     // synchronous rounds executed
}

func key(state []Value) string {
	var b strings.Builder
	b.Grow(len(state))
	for _, v := range state {
		b.WriteByte(byte(v))
	}
	return b.String()
}

func equal(a, b []Value) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Simulate iterates the circuit synchronously from start (a full state:
// inputs followed by gate values) for at most budget rounds. Primary
// inputs are held fixed at their start values.
//
// It returns Converged with the stable state, Cycle with a witness state
// and its period, or Undecided when the budget runs out.
func (c *Circuit) Simulate(start []Value, budget int) Result {
	if err := c.validate(); err != nil {
		panic(err)
	}
	if len(start) != len(c.nodes) {
		panic("cirsim: start state length mismatch")
	}
	for i, v := range start {
		if !v.IsValid() {
			panic(fmt.Sprintf("cirsim: invalid value %q at node %d", byte(v), i))
		}
	}
	state := append([]Value(nil), start...)
	seen := map[string]int{key(state): 0}
	for round := 1; round <= budget; round++ {
		next := c.step(state)
		if equal(next, state) {
			return Result{Kind: Converged, State: next, Rounds: round}
		}
		k := key(next)
		if prev, ok := seen[k]; ok {
			return Result{Kind: Cycle, State: next, Period: round - prev, Rounds: round}
		}
		seen[k] = round
		state = next
	}
	return Result{Kind: Undecided, State: state, Rounds: budget}
}

// FullSimulate runs a complete iteration from a cold start: primary inputs
// set to inputs, all gate nodes initialised to X.
func (c *Circuit) FullSimulate(inputs []Value, budget int) Result {
	if len(inputs) != c.nInputs {
		panic("cirsim: input count mismatch")
	}
	start := make([]Value, len(c.nodes))
	copy(start, inputs)
	for i := c.nInputs; i < len(start); i++ {
		start[i] = X
	}
	return c.Simulate(start, budget)
}

// IncrementalSimulate re-simulates after an input change, warm-starting
// from prev (a previous full state) with primary inputs replaced by
// newInputs. Gate nodes keep their previous values.
func (c *Circuit) IncrementalSimulate(prev []Value, newInputs []Value, budget int) Result {
	if len(prev) != len(c.nodes) || len(newInputs) != c.nInputs {
		panic("cirsim: state/input length mismatch")
	}
	start := append([]Value(nil), prev...)
	copy(start, newInputs)
	return c.Simulate(start, budget)
}
