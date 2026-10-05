package sim

import (
	"container/heap"
	"fmt"
)

// Snapshot is a full, restorable image of a simulation: clock, counters,
// pending events, component states and the RNG state, so that a restored
// run evolves identically to an uninterrupted one.
type Snapshot struct {
	Now        float64
	Seq        uint64
	NextID     uint64
	Processed  int
	RNGState   uint64
	Events     []Event
	Components []ComponentState
}

// ComponentState is one component's saved state inside a Snapshot.
type ComponentState struct {
	Name  string
	State any
}

// Snapshot captures the complete simulation state, including the RNG.
// Pending events are copied by value; their handlers (Go closures) are
// shared by reference, so snapshots are in-memory images.
func (s *Sim) Snapshot() *Snapshot {
	snap := &Snapshot{
		Now:       s.now,
		Seq:       s.seq,
		NextID:    s.nextID,
		Processed: s.processed,
		RNGState:  s.rng.State(),
		Events:    make([]Event, len(s.queue)),
	}
	for i, ev := range s.queue {
		snap.Events[i] = *ev
	}
	for _, c := range s.components {
		snap.Components = append(snap.Components, ComponentState{
			Name:  c.Name(),
			State: c.SaveState(),
		})
	}
	return snap
}

// Restore replaces the simulation state with snap. Components are matched
// by name; every snapshot component must be registered in s.
func (s *Sim) Restore(snap *Snapshot) error {
	s.now = snap.Now
	s.seq = snap.Seq
	s.nextID = snap.NextID
	s.processed = snap.Processed
	s.rng.SetState(snap.RNGState)

	s.queue = make(eventHeap, len(snap.Events))
	for i := range snap.Events {
		ev := snap.Events[i]
		s.queue[i] = &ev
	}
	heap.Init(&s.queue)

	byName := make(map[string]Component, len(s.components))
	for _, c := range s.components {
		byName[c.Name()] = c
	}
	for _, cs := range snap.Components {
		c, ok := byName[cs.Name]
		if !ok {
			return fmt.Errorf("sim: restore: component %q not registered", cs.Name)
		}
		c.LoadState(cs.State)
	}
	return nil
}
