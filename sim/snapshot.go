package sim

import (
	"fmt"
	"sort"
)

// TrainState is the serialisable state of one train.
type TrainState struct {
	ID        string       `json:"id"`
	Pos       int          `json:"pos"`
	Brake     int          `json:"brake"`
	Reserved  []int        `json:"reserved,omitempty"`
	Waiting   bool         `json:"waiting"`
	WaitSince int          `json:"waitSince"`
	Faulty    bool         `json:"faulty"`
	Arrived   bool         `json:"arrived"`
	Traj      []TrackPoint `json:"traj"`
}

// Snapshot is a consistent, serialisable image of the simulation at a
// given tick. Together with the event log entries after that tick it
// fully determines the later state.
type Snapshot struct {
	Tick        int          `json:"tick"`
	NumSections int          `json:"numSections"`
	Occupant    []string     `json:"occupant"`
	ReservedBy  []string     `json:"reservedBy"`
	Trains      []TrainState `json:"trains"`
}

// Snapshot captures the current simulation state.
func (s *Sim) Snapshot() *Snapshot {
	snap := &Snapshot{
		Tick:        s.Tick,
		NumSections: s.NumSections,
		Occupant:    append([]string(nil), s.Occupant...),
		ReservedBy:  append([]string(nil), s.ReservedBy...),
	}
	for _, t := range s.Trains() {
		ts := TrainState{
			ID:        t.ID,
			Pos:       t.Pos,
			Brake:     t.Brake,
			Waiting:   t.Waiting,
			WaitSince: t.WaitSince,
			Faulty:    t.Faulty,
			Arrived:   t.Arrived,
			Traj:      append([]TrackPoint(nil), t.Traj...),
		}
		for sec := range t.Reserved {
			ts.Reserved = append(ts.Reserved, sec)
		}
		sort.Ints(ts.Reserved)
		snap.Trains = append(snap.Trains, ts)
	}
	return snap
}

// State is a canonical comparable view of the simulation, used to check
// that a recovered simulation matches the original.
type State struct {
	Tick       int
	Occupant   []string
	ReservedBy []string
	Trains     []TrainState
}

// State returns the canonical state of the simulation.
func (s *Sim) State() State {
	snap := s.Snapshot()
	return State{
		Tick:       snap.Tick,
		Occupant:   snap.Occupant,
		ReservedBy: snap.ReservedBy,
		Trains:     snap.Trains,
	}
}

// Recover rebuilds a simulation from a snapshot and replays every event
// with a tick later than the snapshot tick, in log order. After each
// replayed event the mutual-exclusion invariants are verified, so any
// duplicate section occupancy makes recovery fail. Reject events are
// evidence only and do not change state.
func Recover(snap *Snapshot, log []Event) (*Sim, error) {
	s := New(snap.NumSections)
	s.Tick = snap.Tick
	copy(s.Occupant, snap.Occupant)
	copy(s.ReservedBy, snap.ReservedBy)
	for _, ts := range snap.Trains {
		t := &Train{
			ID:        ts.ID,
			Pos:       ts.Pos,
			Brake:     ts.Brake,
			Reserved:  make(map[int]bool, len(ts.Reserved)),
			Waiting:   ts.Waiting,
			WaitSince: ts.WaitSince,
			Faulty:    ts.Faulty,
			Arrived:   ts.Arrived,
			Traj:      append([]TrackPoint(nil), ts.Traj...),
		}
		for _, sec := range ts.Reserved {
			t.Reserved[sec] = true
		}
		s.trains[t.ID] = t
	}
	if err := s.Verify(); err != nil {
		return nil, fmt.Errorf("snapshot at tick %d is inconsistent: %w", snap.Tick, err)
	}
	for _, e := range log {
		if e.Tick <= snap.Tick {
			continue
		}
		if err := s.apply(e); err != nil {
			return nil, fmt.Errorf("replay tick %d: %w", e.Tick, err)
		}
		if err := s.Verify(); err != nil {
			return nil, fmt.Errorf("replay tick %d: %w", e.Tick, err)
		}
	}
	return s, nil
}

// apply replays one state-changing event.
func (s *Sim) apply(e Event) error {
	if e.Tick > s.Tick {
		s.Tick = e.Tick
	}
	t := s.trains[e.Train]
	if t == nil {
		return fmt.Errorf("event %s references unknown train %q", e.Type, e.Train)
	}
	switch e.Type {
	case EventGrant:
		for _, sec := range e.Sections {
			if err := s.checkSection(sec); err != nil {
				return err
			}
			t.Reserved[sec] = true
			s.ReservedBy[sec] = t.ID
		}
	case EventRelease:
		for _, sec := range e.Sections {
			if err := s.checkSection(sec); err != nil {
				return err
			}
			delete(t.Reserved, sec)
			if s.ReservedBy[sec] == t.ID {
				s.ReservedBy[sec] = ""
			}
		}
	case EventMove:
		if err := s.checkSection(e.From); err != nil {
			return err
		}
		if err := s.checkSection(e.To); err != nil {
			return err
		}
		if s.Occupant[e.From] != t.ID {
			return fmt.Errorf("move of %s from section %d it does not occupy", t.ID, e.From)
		}
		s.Occupant[e.From] = ""
		t.Pos = e.To
		s.Occupant[e.To] = t.ID
		t.Waiting = false
		t.Traj = append(t.Traj, TrackPoint{Tick: e.Tick, Pos: e.To})
	case EventFault:
		t.Faulty = true
		t.Waiting = false
	case EventArrive:
		if s.Occupant[e.From] != t.ID {
			return fmt.Errorf("arrival of %s from section %d it does not occupy", t.ID, e.From)
		}
		s.Occupant[e.From] = ""
		t.Arrived = true
		t.Waiting = false
	case EventReject:
		// Evidence only; no state change.
	default:
		return fmt.Errorf("unknown event type %q", e.Type)
	}
	return nil
}

func (s *Sim) checkSection(sec int) error {
	if sec < 0 || sec >= s.NumSections {
		return fmt.Errorf("section %d out of range", sec)
	}
	return nil
}
