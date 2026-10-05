package mbt

// Sequence is a shortest action history that reaches a target state,
// plus the final transition it covers.
type Sequence struct {
	Actions []string // full history to replay from the initial state
	Target  string   // expected state after replaying Actions
}

// Explorer generates legal action sequences from the state table.
type Explorer struct {
	model *Model
}

func NewExplorer(m *Model) *Explorer { return &Explorer{model: m} }

// ShortestHistories BFS-computes the shortest action history from the
// initial state to every reachable state. Unreachable states are absent.
func (e *Explorer) ShortestHistories() map[string][]string {
	hist := map[string][]string{e.model.Initial: {}}
	queue := []string{e.model.Initial}
	for len(queue) > 0 {
		s := queue[0]
		queue = queue[1:]
		for _, t := range e.model.LegalFrom(s) {
			if _, ok := hist[t.To]; ok {
				continue
			}
			next := append(append([]string{}, hist[s]...), t.Action)
			hist[t.To] = next
			queue = append(queue, t.To)
		}
	}
	return hist
}

// Plan is the result of sequence generation within a step budget.
type Plan struct {
	// Sequences covers every transition whose covering history fits in
	// the budget: shortest history to From, plus the transition action.
	Sequences []Sequence
	// Histories is the shortest history per reachable state.
	Histories map[string][]string
	// Uncovered lists transitions that need more than MaxSteps to cover.
	Uncovered []Transition
	// Unreachable lists states with no history from the initial state.
	Unreachable []string
	// Closed reports whether the budget sufficed to cover every
	// transition of every reachable state.
	Closed bool
}

// Generate produces transition-covering legal sequences of at most
// maxSteps actions each.
func (e *Explorer) Generate(maxSteps int) Plan {
	hist := e.ShortestHistories()
	plan := Plan{Histories: hist, Closed: true}
	for name := range e.model.States {
		if _, ok := hist[name]; !ok {
			plan.Unreachable = append(plan.Unreachable, name)
		}
	}
	covered := map[Transition]bool{}
	for _, t := range e.model.Transitions {
		h, ok := hist[t.From]
		if !ok {
			continue // from-state unreachable; counted via Unreachable
		}
		if len(h)+1 > maxSteps {
			plan.Uncovered = append(plan.Uncovered, t)
			continue
		}
		seq := append(append([]string{}, h...), t.Action)
		plan.Sequences = append(plan.Sequences, Sequence{Actions: seq, Target: t.To})
		covered[t] = true
	}
	if len(plan.Uncovered) > 0 || len(plan.Unreachable) > 0 {
		plan.Closed = false
	}
	return plan
}
