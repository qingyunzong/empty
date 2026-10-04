// Package desim is a small discrete-event simulation library built only on
// the Go standard library.
//
// Events may schedule successor events, and components may fire spontaneous
// actions that schedule new events. A run terminates only when the event
// queue is empty AND no component has an enabled action; a momentarily empty
// queue is not a stop condition. Runs are bounded by a Budget; when the
// budget is exceeded the result carries evidence of the remaining work
// (pending events and ready components). Snapshots capture the full state,
// including the RNG, so a restored run evolves identically to a run from
// scratch.
package desim

import (
	"container/heap"
	"fmt"
	"sort"
)

// Time is the simulation clock, in integer ticks.
type Time int64

// Event is a scheduled callback. Handlers receive a Context and may use it
// to schedule successor events. So that snapshots remain valid, handlers
// must interact with the simulation only through the Context: schedule via
// ctx, draw randomness from ctx.Rand, and resolve components via
// ctx.Component instead of capturing component pointers in closures.
type Event struct {
	Time  Time
	Label string
	Run   func(ctx *Context)

	seq uint64
}

// Component is a simulation participant that can fire spontaneous actions
// when no events are pending. A component must be able to snapshot and
// restore its own state.
type Component interface {
	Name() string
	// Enabled reports whether the component has an action ready to fire
	// at the given time.
	Enabled(now Time) bool
	// Fire performs the action. It may schedule events via ctx.
	Fire(ctx *Context)
	// SaveState returns a deep copy of the component's state.
	SaveState() any
	// RestoreState overwrites the component's state with a copy
	// previously returned by SaveState.
	RestoreState(state any)
}

// Context is passed to event handlers and component actions.
type Context struct {
	sim *Sim
}

// Now returns the current simulation time.
func (c *Context) Now() Time { return c.sim.now }

// Schedule enqueues an event delay ticks from now.
func (c *Context) Schedule(delay Time, label string, run func(ctx *Context)) {
	c.sim.At(c.sim.now+delay, label, run)
}

// At enqueues an event at an absolute time.
func (c *Context) At(t Time, label string, run func(ctx *Context)) {
	c.sim.At(t, label, run)
}

// Rand returns the simulation's deterministic RNG.
func (c *Context) Rand() *RNG { return c.sim.rng }

// Component returns the registered component with the given name, or nil.
// Handlers should resolve components through this method rather than
// capturing component pointers, so restored snapshots stay consistent.
func (c *Context) Component(name string) Component { return c.sim.Component(name) }

// Logf appends a formatted entry to the simulation trace. The trace is part
// of the snapshot, so restored runs keep a continuous record.
func (c *Context) Logf(format string, args ...any) {
	c.sim.trace = append(c.sim.trace, fmt.Sprintf(format, args...))
}

// Budget bounds a single Run call. Zero values mean "unbounded".
type Budget struct {
	// MaxSteps caps the number of executed steps (events plus component
	// actions) in one Run call.
	MaxSteps uint64
	// MaxTime caps the simulation clock; events scheduled beyond it are
	// left pending and reported as evidence.
	MaxTime Time
}

// PendingEvent describes an event left in the queue, as evidence.
type PendingEvent struct {
	Time  Time
	Label string
}

// Backlog is the evidence of unfinished work returned when a run stops
// because its budget was exceeded.
type Backlog struct {
	PendingEvents   []PendingEvent
	ReadyComponents []string
}

// Result summarizes a Run call.
type Result struct {
	// Completed is true only when the run reached quiescence: the event
	// queue is empty and no component has an enabled action.
	Completed bool
	// Steps is the number of steps executed during this Run call.
	Steps uint64
	// EndTime is the simulation clock when the run stopped.
	EndTime Time
	// Backlog is non-nil when the run stopped early due to the budget.
	Backlog *Backlog
}

// Sim is a discrete-event simulation.
type Sim struct {
	now   Time
	seq   uint64
	steps uint64
	queue eventHeap
	rng   *RNG
	comps []Component
	trace []string
}

// New creates a simulation whose RNG is seeded with seed.
func New(seed uint64) *Sim {
	return &Sim{rng: NewRNG(seed)}
}

// AddComponent registers a component. Registration order defines the
// deterministic firing order.
func (s *Sim) AddComponent(c Component) {
	s.comps = append(s.comps, c)
}

// Component returns the registered component with the given name, or nil.
func (s *Sim) Component(name string) Component {
	for _, c := range s.comps {
		if c.Name() == name {
			return c
		}
	}
	return nil
}

// At enqueues an event at an absolute time (usable before Run starts).
func (s *Sim) At(t Time, label string, run func(ctx *Context)) {
	if t < s.now {
		panic(fmt.Sprintf("desim: scheduling event %q in the past (at %d, now %d)", label, t, s.now))
	}
	s.seq++
	heap.Push(&s.queue, &Event{Time: t, Label: label, Run: run, seq: s.seq})
}

// Now returns the current simulation time.
func (s *Sim) Now() Time { return s.now }

// Trace returns a copy of the log entries recorded via Context.Logf.
func (s *Sim) Trace() []string {
	out := make([]string, len(s.trace))
	copy(out, s.trace)
	return out
}

// Run executes the simulation until quiescence or until the budget is
// exceeded. Quiescence requires BOTH an empty event queue AND no enabled
// component actions; an empty queue alone never ends the run while a
// component can still fire.
func (s *Sim) Run(b Budget) Result {
	ctx := &Context{sim: s}
	startSteps := s.steps
	for {
		if b.MaxSteps > 0 && s.steps-startSteps >= b.MaxSteps {
			return s.exhausted(startSteps)
		}
		if s.queue.Len() > 0 {
			next := s.queue[0]
			if b.MaxTime > 0 && next.Time > b.MaxTime {
				return s.exhausted(startSteps)
			}
			ev := heap.Pop(&s.queue).(*Event)
			s.now = ev.Time
			s.steps++
			ev.Run(ctx)
			continue
		}
		// Queue is empty: components may still have enabled actions.
		fired := false
		for _, c := range s.comps {
			if c.Enabled(s.now) {
				s.steps++
				c.Fire(ctx)
				fired = true
			}
		}
		if !fired {
			return Result{Completed: true, Steps: s.steps - startSteps, EndTime: s.now}
		}
	}
}

// exhausted builds the Result for a budget-exceeded stop, including the
// evidence of work that remained.
func (s *Sim) exhausted(startSteps uint64) Result {
	backlog := &Backlog{}
	for _, ev := range s.queue {
		backlog.PendingEvents = append(backlog.PendingEvents, PendingEvent{Time: ev.Time, Label: ev.Label})
	}
	sort.Slice(backlog.PendingEvents, func(i, j int) bool {
		if backlog.PendingEvents[i].Time != backlog.PendingEvents[j].Time {
			return backlog.PendingEvents[i].Time < backlog.PendingEvents[j].Time
		}
		return backlog.PendingEvents[i].Label < backlog.PendingEvents[j].Label
	})
	for _, c := range s.comps {
		if c.Enabled(s.now) {
			backlog.ReadyComponents = append(backlog.ReadyComponents, c.Name())
		}
	}
	return Result{Completed: false, Steps: s.steps - startSteps, EndTime: s.now, Backlog: backlog}
}

// eventHeap is a min-heap of events ordered by (Time, seq).
type eventHeap []*Event

func (h eventHeap) Len() int { return len(h) }
func (h eventHeap) Less(i, j int) bool {
	if h[i].Time != h[j].Time {
		return h[i].Time < h[j].Time
	}
	return h[i].seq < h[j].seq
}
func (h eventHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *eventHeap) Push(x any)   { *h = append(*h, x.(*Event)) }
func (h *eventHeap) Pop() any {
	old := *h
	n := len(old)
	ev := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return ev
}
