package desim

import "container/heap"

// Snapshot captures the complete state of a Sim: clock, sequence counter,
// step counter, pending events, RNG state, component states, and trace.
// Restoring a snapshot and continuing the run produces exactly the same
// evolution as an uninterrupted run from scratch.
type Snapshot struct {
	now    Time
	seq    uint64
	steps  uint64
	events []*Event
	rng    uint64
	states []any
	trace  []string
}

// Snapshot returns a deep copy of the simulation's current state.
func (s *Sim) Snapshot() *Snapshot {
	snap := &Snapshot{
		now:    s.now,
		seq:    s.seq,
		steps:  s.steps,
		rng:    s.rng.State(),
		events: make([]*Event, len(s.queue)),
		states: make([]any, len(s.comps)),
		trace:  make([]string, len(s.trace)),
	}
	for i, ev := range s.queue {
		cp := *ev
		snap.events[i] = &cp
	}
	for i, c := range s.comps {
		snap.states[i] = c.SaveState()
	}
	copy(snap.trace, s.trace)
	return snap
}

// Restore returns a new Sim in the state captured by snap, sharing the same
// component objects (restored in place) and event handlers as the original.
// Continuing the restored sim evolves identically to the original.
func Restore(snap *Snapshot, comps []Component) *Sim {
	s := &Sim{
		now:   snap.now,
		seq:   snap.seq,
		steps: snap.steps,
		rng:   NewRNG(0),
		comps: comps,
		trace: make([]string, len(snap.trace)),
	}
	s.rng.SetState(snap.rng)
	for _, ev := range snap.events {
		cp := *ev
		s.queue = append(s.queue, &cp)
	}
	heap.Init(&s.queue)
	for i, c := range comps {
		c.RestoreState(snap.states[i])
	}
	copy(s.trace, snap.trace)
	return s
}
