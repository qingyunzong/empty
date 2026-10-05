package statever

import "strings"

// Step is one fired transition in a trace.
type Step struct {
	From  int // state index
	Event int // event index (ID order)
	To    int // state index
}

// CheckResult is the outcome of a bounded invariant check.
type CheckResult struct {
	// Violation is the shortest trace to a bad state, or nil if none was
	// found within the budget. Among shortest traces, the lexicographically
	// smallest event-ID sequence wins.
	Violation []Step
	// Budget is the step budget that was used.
	Budget int
}

// Found reports whether a violating trace was found within budget.
func (r CheckResult) Found() bool { return r.Violation != nil }

// BoundedCheck searches for the shortest trace from the initial state to a
// bad (invariant-violating) state, using at most m.Budget steps.
//
// Breadth-first search expands events in event-ID order, so the first bad
// state dequeued yields the shortest trace, with ties broken by event ID
// order. If no violation is found, the result only establishes that the
// invariant holds within the budget — it is NOT a proof of global safety.
func BoundedCheck(m *Model) CheckResult {
	res := CheckResult{Budget: m.Budget}
	init := m.InitialIndex()
	if m.IsBad(init) {
		res.Violation = []Step{}
		return res
	}
	type node struct {
		state int
		depth int
		path  []Step
	}
	queue := []node{{state: init}}
	visited := map[int]bool{init: true}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur.depth >= m.Budget {
			continue
		}
		for ev := 0; ev < m.NumEvents(); ev++ {
			for _, dst := range m.Next(cur.state, ev) {
				step := Step{From: cur.state, Event: ev, To: dst}
				path := make([]Step, len(cur.path)+1)
				copy(path, cur.path)
				path[len(cur.path)] = step
				if m.IsBad(dst) {
					res.Violation = path
					return res
				}
				if !visited[dst] {
					visited[dst] = true
					queue = append(queue, node{state: dst, depth: cur.depth + 1, path: path})
				}
			}
		}
	}
	return res
}

// FormatTrace renders a trace as "s0 -a-> s1 -b-> s2".
func FormatTrace(m *Model, trace []Step) string {
	if len(trace) == 0 {
		return m.Initial + " (initial state)"
	}
	var b strings.Builder
	b.WriteString(m.StateName(trace[0].From))
	for _, s := range trace {
		b.WriteString(" -")
		b.WriteString(m.EventName(s.Event))
		b.WriteString("-> ")
		b.WriteString(m.StateName(s.To))
	}
	return b.String()
}
