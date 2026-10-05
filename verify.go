package statever

import "fmt"

// VerifyFairLasso independently checks a claimed fair infinite
// counterexample by unrolling it against the state table. It shares no
// search state with FairCheck: every step is re-simulated, the loop
// closure is re-verified, and fairness (every continuously ready event
// occurs in the cycle) is recomputed from the cycle's states.
//
// A nil return means the lasso is a valid fair infinite violation.
func VerifyFairLasso(m *Model, l *Lasso) error {
	if l == nil {
		return fmt.Errorf("nil lasso")
	}
	if len(l.Cycle) == 0 {
		return fmt.Errorf("cycle must be non-empty")
	}

	// Unroll the prefix from the initial state.
	cur := m.InitialIndex()
	visitsBad := m.IsBad(cur)
	for i, st := range l.Prefix {
		if st.From != cur {
			return fmt.Errorf("prefix step %d: from %q, expected %q",
				i, m.StateName(st.From), m.StateName(cur))
		}
		if !validTransition(m, st) {
			return fmt.Errorf("prefix step %d: no transition %q -%s-> %q",
				i, m.StateName(st.From), m.EventName(st.Event), m.StateName(st.To))
		}
		cur = st.To
		if m.IsBad(cur) {
			visitsBad = true
		}
	}

	// The prefix must end exactly at the cycle entry.
	entry := l.Cycle[0].From
	if cur != entry {
		return fmt.Errorf("prefix ends at %q, cycle starts at %q",
			m.StateName(cur), m.StateName(entry))
	}

	// Unroll the cycle, collecting its states and fired events.
	cycleStates := map[int]bool{}
	usedEvents := map[int]bool{}
	for i, st := range l.Cycle {
		if st.From != cur {
			return fmt.Errorf("cycle step %d: from %q, expected %q",
				i, m.StateName(st.From), m.StateName(cur))
		}
		if !validTransition(m, st) {
			return fmt.Errorf("cycle step %d: no transition %q -%s-> %q",
				i, m.StateName(st.From), m.EventName(st.Event), m.StateName(st.To))
		}
		cycleStates[st.From] = true
		usedEvents[st.Event] = true
		cur = st.To
		if m.IsBad(cur) {
			visitsBad = true
		}
	}
	if cur != entry {
		return fmt.Errorf("cycle does not close: ends at %q, started at %q",
			m.StateName(cur), m.StateName(entry))
	}

	// The infinite trace must violate the invariant.
	if !visitsBad {
		return fmt.Errorf("trace never visits a bad state: not a violation")
	}

	// Fairness: every event enabled at every cycle state must occur.
	states := make([]int, 0, len(cycleStates))
	for s := range cycleStates {
		states = append(states, s)
	}
	for _, ev := range ContinuouslyEnabled(m, states) {
		if !usedEvents[ev] {
			return fmt.Errorf("unfair cycle: event %q is continuously ready but never fires",
				m.EventName(ev))
		}
	}
	return nil
}

// validTransition checks the step exists in the state table.
func validTransition(m *Model, st Step) bool {
	if st.From < 0 || st.From >= m.NumStates() || st.Event < 0 || st.Event >= m.NumEvents() {
		return false
	}
	for _, dst := range m.Next(st.From, st.Event) {
		if dst == st.To {
			return true
		}
	}
	return false
}
