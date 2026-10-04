package mcheck

import "fmt"

// ReplayResult is the verdict of replaying a trace against a spec.
type ReplayResult struct {
	Legal    bool  // every event was applicable under the spec's fault budget
	Violates bool  // safety failed at the initial state or after some event
	Err      error // legality failure detail, when Legal is false
	Final    View  // system state after the last applied event
}

// Accepts reports whether the replayed trace is a valid safety
// certificate: fully legal and actually violating safety.
func (r ReplayResult) Accepts() bool {
	return r.Legal && r.Violates
}

// Replay deterministically re-executes trace against spec, checking
// that every event is legal: a delivered or duplicated message must
// currently be in flight to a live node, duplication requires
// AllowDup and consumes the single duplication budget, and a crash
// requires AllowCrash, a live node, and the single crash budget.
// Safety is evaluated on the initial state and after every event.
func Replay(spec Spec, trace []Event) ReplayResult {
	if err := spec.Validate(); err != nil {
		return ReplayResult{Err: err}
	}
	st := state{
		nodes:    append([]string(nil), spec.Nodes...),
		crashed:  make([]bool, len(spec.Nodes)),
		inflight: append([]Message(nil), spec.Inbox...),
	}
	violates := !spec.Safety(st.view())
	for i, ev := range trace {
		if err := applyEvent(spec, &st, ev); err != nil {
			return ReplayResult{Legal: false, Err: fmt.Errorf("event %d (%v): %w", i, ev, err), Final: st.view()}
		}
		if !spec.Safety(st.view()) {
			violates = true
		}
	}
	return ReplayResult{Legal: true, Violates: violates, Final: st.view()}
}

// applyEvent applies one trace event to st, verifying legality.
func applyEvent(spec Spec, st *state, ev Event) error {
	switch ev.Kind {
	case Deliver, Duplicate:
		idx := indexInFlight(st, ev.Msg)
		if idx < 0 {
			return fmt.Errorf("message %s->n%d is not in flight", ev.Msg.Kind, ev.Msg.To)
		}
		if ev.Kind == Duplicate {
			if !spec.AllowDup {
				return fmt.Errorf("duplication not enabled by spec")
			}
			if st.dupUsed {
				return fmt.Errorf("duplication budget already spent")
			}
			st.dupUsed = true
		} else {
			st.inflight = removeAt(st.inflight, idx)
		}
		nodes := append([]string(nil), st.nodes...)
		st.inflight = applyTable(spec.Table, nodes, st.inflight, ev.Msg)
		st.nodes = nodes
		return nil
	case Crash:
		if !spec.AllowCrash {
			return fmt.Errorf("crashes not enabled by spec")
		}
		if st.crashUsed {
			return fmt.Errorf("crash budget already spent")
		}
		if ev.Node < 0 || ev.Node >= len(st.nodes) {
			return fmt.Errorf("unknown node %d", ev.Node)
		}
		if st.crashed[ev.Node] {
			return fmt.Errorf("node %d already crashed", ev.Node)
		}
		crashed := append([]bool(nil), st.crashed...)
		crashed[ev.Node] = true
		st.crashed = crashed
		st.crashUsed = true
		return nil
	}
	return fmt.Errorf("unknown event kind %d", ev.Kind)
}

// indexInFlight finds a copy of m addressed to a live node.
func indexInFlight(st *state, m Message) int {
	for i, f := range st.inflight {
		if f == m && !st.crashed[f.To] {
			return i
		}
	}
	return -1
}
