// Package sim is a small discrete-event simulation library.
//
// Events may spawn successor events while being handled. Components may
// additionally offer condition-triggered actions. The simulation stops only
// when there are no pending events AND no component has a triggerable
// action; a momentarily empty event queue is not a stop condition.
package sim

import (
	"container/heap"
	"fmt"
)

// Handler processes an event. It may schedule successor events on s.
type Handler func(s *Sim, e *Event)

// Event is a scheduled occurrence.
type Event struct {
	ID      uint64
	Time    float64
	Kind    string
	Data    any
	seq     uint64
	handler Handler
}

// Action is a conditional activity offered by a Component.
type Action interface {
	// Describe returns a short human-readable description, used in
	// budget-exceeded evidence.
	Describe() string
	// Fire executes the action; it may schedule events on s.
	Fire(s *Sim)
}

// Component is a simulation entity that can offer condition-triggered
// actions and can be snapshotted.
type Component interface {
	Name() string
	// Triggerable returns the actions the component can fire right now.
	// It is consulted whenever the event queue is empty.
	Triggerable(s *Sim) []Action
	// SaveState returns a snapshot-friendly copy of the component state.
	SaveState() any
	// LoadState restores a state previously produced by SaveState.
	LoadState(state any)
}

// Budget limits a Run. Zero fields mean "unlimited".
type Budget struct {
	// MaxEvents caps the number of processed units (events + actions).
	MaxEvents int
	// MaxTime caps the simulation clock; events strictly after MaxTime
	// are not executed.
	MaxTime float64
}

// EventSummary describes a pending event in budget-exceeded evidence.
type EventSummary struct {
	ID   uint64
	Time float64
	Kind string
}

// Evidence is the backlog proof attached to a BudgetExceededError: what
// work was still outstanding when the budget ran out.
type Evidence struct {
	Now            float64
	Processed      int
	PendingEvents  []EventSummary
	PendingActions []string
}

// BudgetExceededError is returned by Run when a budget limit is hit while
// work remains. It always carries Evidence of the outstanding work.
type BudgetExceededError struct {
	Reason   string
	Evidence Evidence
}

func (e *BudgetExceededError) Error() string {
	return fmt.Sprintf("sim: budget exceeded (%s) at t=%g after %d steps: %d events pending, %d actions triggerable",
		e.Reason, e.Evidence.Now, e.Evidence.Processed,
		len(e.Evidence.PendingEvents), len(e.Evidence.PendingActions))
}

// Sim is the simulation state: clock, event queue, RNG and components.
type Sim struct {
	now        float64
	seq        uint64
	nextID     uint64
	queue      eventHeap
	rng        *RNG
	components []Component
	processed  int

	// Budget limits the next Run call.
	Budget Budget

	// OnEvent, if set, is called just before each event handler runs.
	OnEvent func(e *Event)
	// OnAction, if set, is called just before each action fires.
	OnAction func(c Component, a Action)
}

// New creates an empty simulation with an RNG seeded by seed.
func New(seed uint64) *Sim {
	return &Sim{rng: NewRNG(seed)}
}

// Now returns the current simulation time.
func (s *Sim) Now() float64 { return s.now }

// RNG returns the simulation random source.
func (s *Sim) RNG() *RNG { return s.rng }

// Processed returns how many units (events + actions) have been executed.
func (s *Sim) Processed() int { return s.processed }

// Register adds a component to the simulation.
func (s *Sim) Register(c Component) {
	s.components = append(s.components, c)
}

// ScheduleAt schedules an event at absolute time at. It panics if at is
// before the current time.
func (s *Sim) ScheduleAt(at float64, kind string, data any, h Handler) *Event {
	if at < s.now {
		panic(fmt.Sprintf("sim: cannot schedule %q at %g, now is %g", kind, at, s.now))
	}
	s.seq++
	s.nextID++
	ev := &Event{ID: s.nextID, Time: at, Kind: kind, Data: data, seq: s.seq, handler: h}
	heap.Push(&s.queue, ev)
	return ev
}

// Schedule schedules an event delay time units from now.
func (s *Sim) Schedule(delay float64, kind string, data any, h Handler) *Event {
	return s.ScheduleAt(s.now+delay, kind, data, h)
}

// Pending returns summaries of all events currently in the queue.
func (s *Sim) Pending() []EventSummary {
	out := make([]EventSummary, 0, len(s.queue))
	for _, ev := range s.queue {
		out = append(out, EventSummary{ID: ev.ID, Time: ev.Time, Kind: ev.Kind})
	}
	return out
}

// triggerable collects all currently triggerable component actions.
func (s *Sim) triggerable() []ComponentAction {
	var out []ComponentAction
	for _, c := range s.components {
		for _, a := range c.Triggerable(s) {
			out = append(out, ComponentAction{Component: c, Action: a})
		}
	}
	return out
}

// ComponentAction pairs a component with one of its triggerable actions.
type ComponentAction struct {
	Component Component
	Action    Action
}

// evidence builds the backlog proof for a budget-exceeded error.
func (s *Sim) evidence() Evidence {
	ev := Evidence{
		Now:           s.now,
		Processed:     s.processed,
		PendingEvents: s.Pending(),
	}
	for _, ca := range s.triggerable() {
		ev.PendingActions = append(ev.PendingActions,
			ca.Component.Name()+": "+ca.Action.Describe())
	}
	return ev
}

// budgetExceeded reports whether remaining work may still be executed.
func (s *Sim) budgetExceeded(nextEventTime float64, hasEvent bool) (bool, string) {
	if s.Budget.MaxEvents > 0 && s.processed >= s.Budget.MaxEvents {
		return true, fmt.Sprintf("event budget %d reached", s.Budget.MaxEvents)
	}
	if hasEvent && s.Budget.MaxTime > 0 && nextEventTime > s.Budget.MaxTime {
		return true, fmt.Sprintf("time budget %g reached", s.Budget.MaxTime)
	}
	return false, ""
}

// Run executes the simulation until there are no pending events and no
// component offers a triggerable action, or until the budget is exceeded.
// A momentarily empty queue does not stop the run: components are always
// consulted before terminating. On budget exhaustion it returns a
// *BudgetExceededError carrying Evidence of the outstanding work.
func (s *Sim) Run() error {
	for {
		if len(s.queue) > 0 {
			next := s.queue[0]
			if exceeded, reason := s.budgetExceeded(next.Time, true); exceeded {
				return &BudgetExceededError{Reason: reason, Evidence: s.evidence()}
			}
			ev := heap.Pop(&s.queue).(*Event)
			s.now = ev.Time
			s.processed++
			if s.OnEvent != nil {
				s.OnEvent(ev)
			}
			ev.handler(s, ev)
			continue
		}
		// Queue is empty: that alone is not a stop condition. Components
		// may still have triggerable actions that derive new events.
		actions := s.triggerable()
		if len(actions) == 0 {
			return nil
		}
		if exceeded, reason := s.budgetExceeded(0, false); exceeded {
			return &BudgetExceededError{Reason: reason, Evidence: s.evidence()}
		}
		for _, ca := range actions {
			s.processed++
			if s.OnAction != nil {
				s.OnAction(ca.Component, ca.Action)
			}
			ca.Action.Fire(s)
		}
	}
}
