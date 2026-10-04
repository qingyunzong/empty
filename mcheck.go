// Package mcheck is a small explicit-state model checker for
// message-passing protocols.
//
// A protocol is described by a per-node state table: given a node's
// current state and an incoming message kind, the table yields the
// node's next state and any messages it sends in response. The checker
// explores every interleaving of message deliveries, optionally
// injecting at most one message duplication and at most one node
// crash, and reports the shortest trace that violates a safety
// predicate.
//
// Only messages that have actually been sent (and not yet delivered)
// can be delivered: the network never invents messages. Exploration is
// bounded by a depth/state budget; when the budget cuts the search
// short the result is BudgetExhausted, which is deliberately distinct
// from Safe (fully explored, no counterexample).
package mcheck

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// MaxMessages is the maximum number of initial in-flight messages a
// Spec may carry.
const MaxMessages = 12

// Message is a value in flight between nodes.
type Message struct {
	To   int    // destination node index
	Kind string // looked up in the state table
	Data string // opaque payload, carried but not interpreted
}

// Effect is the result of a node handling a message.
type Effect struct {
	Next string    // next node state; empty means "keep current state"
	Send []Message // messages emitted by the handler
}

// Table maps a node state and a message kind to an Effect:
// Table[nodeState][msgKind]. A missing entry means the message is
// consumed and dropped with no state change and no sends.
type Table map[string]map[string]Effect

func (t Table) lookup(state, kind string) (Effect, bool) {
	row, ok := t[state]
	if !ok {
		return Effect{}, false
	}
	e, ok := row[kind]
	return e, ok
}

// View is the snapshot of the system handed to the Safety predicate.
// The slices are shared with the checker; predicates must not mutate
// them.
type View struct {
	Nodes    []string  // current state of each node
	Crashed  []bool    // per-node crash flags
	Inflight []Message // sent but not yet delivered messages
}

// Spec describes a protocol model to check.
type Spec struct {
	Nodes  []string  // initial state of each node
	Inbox  []Message // initial in-flight messages (at most MaxMessages)
	Table  Table     // node state table
	Safety func(View) bool

	// MaxDepth bounds the number of events on any explored trace;
	// values <= 0 mean unbounded. MaxStates bounds the number of
	// expanded states; values <= 0 mean unbounded. If either bound
	// cuts the search short, Check reports BudgetExhausted rather
	// than Safe.
	MaxDepth  int
	MaxStates int

	AllowDup   bool // enumerate one duplicated delivery
	AllowCrash bool // enumerate one node crash
}

// Validate reports whether the spec is well formed.
func (s Spec) Validate() error {
	if len(s.Nodes) == 0 {
		return errors.New("mcheck: spec has no nodes")
	}
	if len(s.Inbox) > MaxMessages {
		return fmt.Errorf("mcheck: %d initial messages exceed the limit of %d", len(s.Inbox), MaxMessages)
	}
	for i, m := range s.Inbox {
		if m.To < 0 || m.To >= len(s.Nodes) {
			return fmt.Errorf("mcheck: inbox message %d addressed to unknown node %d", i, m.To)
		}
	}
	if s.Safety == nil {
		return errors.New("mcheck: nil Safety predicate")
	}
	return nil
}

// EventKind identifies the kind of a step on a trace.
type EventKind int

const (
	// Deliver removes a message from the network and applies it.
	Deliver EventKind = iota
	// Duplicate applies a message but leaves a copy in the network.
	Duplicate
	// Crash marks a node as crashed; it stops handling messages.
	Crash
)

// Event is a single step on a trace.
type Event struct {
	Kind EventKind
	Msg  Message // for Deliver and Duplicate
	Node int     // for Crash
}

func (e Event) String() string {
	switch e.Kind {
	case Deliver:
		return fmt.Sprintf("deliver %s->n%d(%s)", e.Msg.Kind, e.Msg.To, e.Msg.Data)
	case Duplicate:
		return fmt.Sprintf("duplicate %s->n%d(%s)", e.Msg.Kind, e.Msg.To, e.Msg.Data)
	case Crash:
		return fmt.Sprintf("crash n%d", e.Node)
	}
	return "unknown"
}

// Outcome is the verdict of a Check run.
type Outcome int

const (
	// Safe means the reachable state space was fully explored within
	// budget and no safety violation exists.
	Safe Outcome = iota
	// Violation means a safety counterexample was found; Result.Trace
	// holds a shortest one.
	Violation
	// BudgetExhausted means the search was cut short by MaxDepth or
	// MaxStates before the state space closed; no conclusion about
	// safety can be drawn.
	BudgetExhausted
)

func (o Outcome) String() string {
	switch o {
	case Safe:
		return "safe"
	case Violation:
		return "violation"
	case BudgetExhausted:
		return "budget-exhausted"
	}
	return "unknown"
}

// Result is the outcome of Check.
type Result struct {
	Outcome  Outcome
	Trace    []Event // shortest counterexample, only when Outcome == Violation
	Explored int     // number of states expanded
}

// state is a full system configuration.
type state struct {
	nodes     []string
	crashed   []bool
	inflight  []Message
	dupUsed   bool
	crashUsed bool
}

func (st state) view() View {
	return View{Nodes: st.nodes, Crashed: st.crashed, Inflight: st.inflight}
}

// key canonicalizes a state for the visited set. In-flight messages
// form a multiset, so they are sorted before hashing.
func (st state) key() string {
	var b strings.Builder
	b.WriteString(strings.Join(st.nodes, "\x00"))
	b.WriteByte('\x01')
	for _, c := range st.crashed {
		if c {
			b.WriteByte('1')
		} else {
			b.WriteByte('0')
		}
	}
	b.WriteByte('\x01')
	ms := append([]Message(nil), st.inflight...)
	sort.Slice(ms, func(i, j int) bool {
		if ms[i].To != ms[j].To {
			return ms[i].To < ms[j].To
		}
		if ms[i].Kind != ms[j].Kind {
			return ms[i].Kind < ms[j].Kind
		}
		return ms[i].Data < ms[j].Data
	})
	for _, m := range ms {
		fmt.Fprintf(&b, "%d\x02%s\x02%s\x03", m.To, m.Kind, m.Data)
	}
	if st.dupUsed {
		b.WriteByte('D')
	}
	if st.crashUsed {
		b.WriteByte('C')
	}
	return b.String()
}

func removeAt(ms []Message, i int) []Message {
	out := make([]Message, 0, len(ms)-1)
	out = append(out, ms[:i]...)
	return append(out, ms[i+1:]...)
}

// applyTable runs the state table for a delivery of m to its
// destination, mutating nodes and inflight in place.
func applyTable(t Table, nodes []string, inflight []Message, m Message) []Message {
	eff, ok := t.lookup(nodes[m.To], m.Kind)
	if !ok {
		return inflight // message dropped, no transition
	}
	if eff.Next != "" {
		nodes[m.To] = eff.Next
	}
	return append(inflight, eff.Send...)
}

type step struct {
	ev   Event
	next state
}

// successors enumerates every enabled event and the resulting state.
func successors(spec Spec, st state) []step {
	var out []step
	for i, m := range st.inflight {
		if st.crashed[m.To] {
			continue
		}
		ns := st
		ns.nodes = append([]string(nil), st.nodes...)
		ns.inflight = removeAt(st.inflight, i)
		ns.inflight = applyTable(spec.Table, ns.nodes, ns.inflight, m)
		out = append(out, step{Event{Kind: Deliver, Msg: m}, ns})

		if spec.AllowDup && !st.dupUsed {
			ds := st
			ds.nodes = append([]string(nil), st.nodes...)
			ds.inflight = append([]Message(nil), st.inflight...)
			ds.inflight = applyTable(spec.Table, ds.nodes, ds.inflight, m)
			ds.dupUsed = true
			out = append(out, step{Event{Kind: Duplicate, Msg: m}, ds})
		}
	}
	if spec.AllowCrash && !st.crashUsed {
		for n := range st.nodes {
			if st.crashed[n] {
				continue
			}
			cs := st
			cs.crashed = append([]bool(nil), st.crashed...)
			cs.crashed[n] = true
			cs.crashUsed = true
			out = append(out, step{Event{Kind: Crash, Node: n}, cs})
		}
	}
	return out
}

// hasEnabled reports whether any event can still fire from st.
func hasEnabled(spec Spec, st state) bool {
	for _, m := range st.inflight {
		if !st.crashed[m.To] {
			return true
		}
	}
	if spec.AllowCrash && !st.crashUsed {
		for _, c := range st.crashed {
			if !c {
				return true
			}
		}
	}
	return false
}

// Check explores the reachable state space of spec breadth-first and
// reports the shortest safety counterexample, if one exists within
// budget.
func Check(spec Spec) (Result, error) {
	if err := spec.Validate(); err != nil {
		return Result{}, err
	}
	init := state{
		nodes:    append([]string(nil), spec.Nodes...),
		crashed:  make([]bool, len(spec.Nodes)),
		inflight: append([]Message(nil), spec.Inbox...),
	}
	if !spec.Safety(init.view()) {
		return Result{Outcome: Violation, Explored: 1}, nil
	}
	type item struct {
		st    state
		trace []Event
	}
	queue := []item{{st: init}}
	seen := map[string]struct{}{init.key(): {}}
	explored := 0
	truncated := false
	for len(queue) > 0 {
		it := queue[0]
		queue = queue[1:]
		explored++
		if spec.MaxStates > 0 && explored > spec.MaxStates {
			truncated = true
			break
		}
		if spec.MaxDepth > 0 && len(it.trace) >= spec.MaxDepth {
			if hasEnabled(spec, it.st) {
				truncated = true
			}
			continue
		}
		for _, s := range successors(spec, it.st) {
			k := s.next.key()
			if _, ok := seen[k]; ok {
				continue
			}
			seen[k] = struct{}{}
			trace := make([]Event, len(it.trace)+1)
			copy(trace, it.trace)
			trace[len(it.trace)] = s.ev
			if !spec.Safety(s.next.view()) {
				return Result{Outcome: Violation, Trace: trace, Explored: explored}, nil
			}
			queue = append(queue, item{st: s.next, trace: trace})
		}
	}
	if truncated {
		return Result{Outcome: BudgetExhausted, Explored: explored}, nil
	}
	return Result{Outcome: Safe, Explored: explored}, nil
}
