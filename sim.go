package circsim

// Status is the termination outcome of a simulation run.
type Status int

const (
	// Converged: a round produced a state identical to the previous
	// one, so Values is a stable fixpoint.
	Converged Status = iota
	// Cyclic: a round revisited an earlier state, so the circuit
	// oscillates; Period and Witness describe the cycle.
	Cyclic
	// Exhausted: the round budget ran out before convergence or a
	// detected cycle; the outcome is undecided.
	Exhausted
)

func (s Status) String() string {
	switch s {
	case Converged:
		return "converged"
	case Cyclic:
		return "cyclic"
	case Exhausted:
		return "exhausted"
	}
	return "?"
}

// Result reports the outcome of a simulation run.
type Result struct {
	Status  Status
	Rounds  int       // synchronous rounds executed in this run
	Values  []Value   // final state (stable when Status == Converged)
	Period  int       // cycle length, only when Status == Cyclic
	Witness [][]Value // one full period of states, only when Status == Cyclic
}

func cloneState(st []Value) []Value {
	return append([]Value(nil), st...)
}

func stateKey(st []Value) string {
	b := make([]byte, len(st))
	for i, v := range st {
		b[i] = byte(v)
	}
	return string(b)
}

func statesEqual(a, b []Value) bool {
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

func copyInputs(inputs map[int]Value) map[int]Value {
	m := make(map[int]Value, len(inputs))
	for n, v := range inputs {
		m[n] = v
	}
	return m
}

// IterateFull is the reference simulator: every round it re-evaluates
// every gate from the current state and applies all net updates
// synchronously. It runs at most budget rounds.
func IterateFull(c *Circuit, inputs map[int]Value, initial []Value, budget int) Result {
	state := cloneState(initial)
	for n, v := range inputs {
		state[n] = v
	}
	history := map[string]int{stateKey(state): 0}
	states := [][]Value{cloneState(state)}
	gateOut := make([]Value, len(c.Gates))
	for round := 1; ; round++ {
		if round > budget {
			return Result{Status: Exhausted, Rounds: round - 1, Values: state}
		}
		for i, g := range c.Gates {
			args := make([]Value, len(g.In))
			for j, n := range g.In {
				args[j] = state[n]
			}
			gateOut[i] = g.Kind.Eval(args)
		}
		next := make([]Value, c.NumNets)
		for n := 0; n < c.NumNets; n++ {
			next[n] = c.netValue(inputs, gateOut, n)
		}
		if statesEqual(next, state) {
			return Result{Status: Converged, Rounds: round, Values: next}
		}
		k := stateKey(next)
		if r, ok := history[k]; ok {
			witness := make([][]Value, len(states)-r)
			for i := range witness {
				witness[i] = cloneState(states[r+i])
			}
			return Result{
				Status:  Cyclic,
				Rounds:  round,
				Values:  next,
				Period:  len(states) - r,
				Witness: witness,
			}
		}
		history[k] = len(states)
		states = append(states, next)
		state = next
	}
}

// Simulator is an incremental simulator. It caches gate outputs and
// re-evaluates only gates whose inputs changed (dirty tracking), while
// preserving exactly the synchronous round semantics of IterateFull.
// Inputs can be changed between runs with SetInput.
type Simulator struct {
	c       *Circuit
	inputs  map[int]Value
	state   []Value
	gateOut []Value
	dirty   []bool
	queue   []int
	history map[string]int
	states  [][]Value
}

// NewSimulator creates a simulator starting from c.InitialState(inputs).
func NewSimulator(c *Circuit, inputs map[int]Value) *Simulator {
	s := &Simulator{
		c:       c,
		inputs:  copyInputs(inputs),
		gateOut: make([]Value, len(c.Gates)),
		dirty:   make([]bool, len(c.Gates)),
	}
	// Cached outputs start at X, matching InitialState: driven nets
	// start at X, so a gate evaluating to X on the first round
	// correctly counts as "no change".
	for i := range s.gateOut {
		s.gateOut[i] = X
	}
	s.state = c.InitialState(s.inputs)
	for i := range c.Gates {
		s.dirty[i] = true
		s.queue = append(s.queue, i)
	}
	s.resetHistory()
	return s
}

func (s *Simulator) resetHistory() {
	s.history = map[string]int{stateKey(s.state): 0}
	s.states = [][]Value{cloneState(s.state)}
}

// State returns a copy of the current net values.
func (s *Simulator) State() []Value {
	return cloneState(s.state)
}

// SetInput changes an external input and resumes from the current
// state on the next Run. Cycle history is discarded because the
// circuit dynamics changed.
func (s *Simulator) SetInput(net int, v Value) {
	s.inputs[net] = v
	if s.c.isInput[net] && s.state[net] != v {
		s.state[net] = v
		for _, gi := range s.c.readers[net] {
			s.markDirty(gi)
		}
	}
	s.resetHistory()
}

func (s *Simulator) markDirty(gi int) {
	if !s.dirty[gi] {
		s.dirty[gi] = true
		s.queue = append(s.queue, gi)
	}
}

// step evaluates dirty gates against the current state, applies net
// updates synchronously, and returns the next state.
func (s *Simulator) step() []Value {
	changedNets := map[int]bool{}
	for _, gi := range s.queue {
		g := s.c.Gates[gi]
		args := make([]Value, len(g.In))
		for j, n := range g.In {
			args[j] = s.state[n]
		}
		out := g.Kind.Eval(args)
		if out != s.gateOut[gi] {
			s.gateOut[gi] = out
			changedNets[g.Out] = true
		}
		s.dirty[gi] = false
	}
	s.queue = s.queue[:0]
	next := cloneState(s.state)
	for n := range changedNets {
		next[n] = s.c.netValue(s.inputs, s.gateOut, n)
	}
	for n := range s.c.Inputs {
		net := s.c.Inputs[n]
		if v, ok := s.inputs[net]; ok {
			next[net] = v
		}
	}
	for n, v := range next {
		if v != s.state[n] {
			for _, gi := range s.c.readers[n] {
				s.markDirty(gi)
			}
		}
	}
	return next
}

// Run executes at most budget synchronous rounds from the current
// state and reports convergence, a cycle witness, or budget
// exhaustion. The result is identical to IterateFull started from the
// same state and inputs.
func (s *Simulator) Run(budget int) Result {
	for round := 1; ; round++ {
		if round > budget {
			return Result{Status: Exhausted, Rounds: round - 1, Values: cloneState(s.state)}
		}
		next := s.step()
		if statesEqual(next, s.state) {
			s.state = next
			return Result{Status: Converged, Rounds: round, Values: cloneState(next)}
		}
		k := stateKey(next)
		if r, ok := s.history[k]; ok {
			period := len(s.states) - r
			witness := make([][]Value, period)
			for i := range witness {
				witness[i] = cloneState(s.states[r+i])
			}
			s.state = next
			// Restart history so a following Run re-measures the
			// same period instead of reporting a stale shorter one.
			s.resetHistory()
			return Result{
				Status:  Cyclic,
				Rounds:  round,
				Values:  cloneState(next),
				Period:  period,
				Witness: witness,
			}
		}
		s.history[k] = len(s.states)
		s.states = append(s.states, cloneState(next))
		s.state = next
	}
}
