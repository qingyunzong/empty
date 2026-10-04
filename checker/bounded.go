package checker

// ShortestViolation searches level by level, up to budget steps, for the
// shortest trace from the initial state to a bad state. Events are expanded
// in event ID order and states are dequeued FIFO, so the first bad state
// generated has the lexicographically smallest event ID sequence among all
// shortest violating traces.
//
// A negative result only means the invariant holds within the budget; it is
// NOT a proof of global safety (see ExactSafety).
func (m *Model) ShortestViolation(budget int) (Trace, bool) {
	n := m.NumStates()
	prev := make([]int, n)
	prevEvent := make([]int, n)
	depth := make([]int, n)
	visited := make([]bool, n)
	for i := range prev {
		prev[i] = -1
	}
	init := m.InitState()
	visited[init] = true
	if m.IsBad(init) {
		return Trace{States: []string{m.Spec.Initial}, Events: []string{}}, true
	}
	queue := []int{init}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if depth[cur] >= budget {
			continue
		}
		for e := 0; e < m.NumEvents(); e++ {
			for _, nxt := range m.delta[cur][e] {
				if visited[nxt] {
					continue
				}
				visited[nxt] = true
				prev[nxt] = cur
				prevEvent[nxt] = e
				depth[nxt] = depth[cur] + 1
				if m.IsBad(nxt) {
					return m.buildTrace(prev, prevEvent, nxt), true
				}
				queue = append(queue, nxt)
			}
		}
	}
	return Trace{}, false
}

// ExactSafety exhaustively checks the finite state graph: over n states a
// bad state is reachable iff it is reachable within n steps, so the bounded
// search with budget n is exact. This is what separates "no error within
// the budget" from genuine global safety.
func (m *Model) ExactSafety() (Trace, bool) {
	return m.ShortestViolation(m.NumStates())
}

func (m *Model) buildTrace(prev, prevEvent []int, last int) Trace {
	var states []string
	var events []string
	for cur := last; cur >= 0; cur = prev[cur] {
		states = append(states, m.Spec.States[cur])
		if prev[cur] >= 0 {
			events = append(events, m.Spec.Events[prevEvent[cur]])
		}
	}
	for i, j := 0, len(states)-1; i < j; i, j = i+1, j-1 {
		states[i], states[j] = states[j], states[i]
	}
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	if events == nil {
		events = []string{}
	}
	return Trace{States: states, Events: events}
}

// shortestPath is a BFS (events in ID order) from the initial state to
// target over the full graph, returning the shortest, lexicographically
// smallest-by-event-ID path.
func (m *Model) shortestPath(target int) (Trace, bool) {
	n := m.NumStates()
	prev := make([]int, n)
	prevEvent := make([]int, n)
	visited := make([]bool, n)
	for i := range prev {
		prev[i] = -1
	}
	init := m.InitState()
	if init == target {
		return Trace{States: []string{m.Spec.States[init]}, Events: []string{}}, true
	}
	visited[init] = true
	queue := []int{init}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for e := 0; e < m.NumEvents(); e++ {
			for _, nxt := range m.delta[cur][e] {
				if visited[nxt] {
					continue
				}
				visited[nxt] = true
				prev[nxt] = cur
				prevEvent[nxt] = e
				if nxt == target {
					return m.buildTrace(prev, prevEvent, nxt), true
				}
				queue = append(queue, nxt)
			}
		}
	}
	return Trace{}, false
}
