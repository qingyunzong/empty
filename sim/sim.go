// Package sim implements a discrete-time train simulation over a single
// line of mutually exclusive sections. A train may enter the next section
// only if every section within its braking distance ahead is reserved by
// itself. Reservation conflicts are resolved in favour of the train that
// has been waiting the longest, ties broken by train ID. Faulty trains
// keep occupying their current section forever.
package sim

import (
	"fmt"
	"sort"
)

// EventType classifies entries in the simulation event log.
type EventType string

const (
	EventGrant   EventType = "grant"   // reservations granted
	EventRelease EventType = "release" // reservations released
	EventReject  EventType = "reject"  // reservation request rejected (evidence)
	EventMove    EventType = "move"    // train moved From -> To
	EventFault   EventType = "fault"   // train broke down, keeps its section
	EventArrive  EventType = "arrive"  // train left the last section
)

// Blocker is the evidence for a rejected reservation request: the section
// that could not be reserved and who holds it.
type Blocker struct {
	Section    int    `json:"section"`
	Occupant   string `json:"occupant,omitempty"`
	ReservedBy string `json:"reservedBy,omitempty"`
}

// Event is one immutable entry in the simulation log. State-changing
// events carry everything needed to replay them during recovery.
type Event struct {
	Tick     int       `json:"tick"`
	Type     EventType `json:"type"`
	Train    string    `json:"train"`
	Sections []int     `json:"sections,omitempty"`
	From     int       `json:"from,omitempty"`
	To       int       `json:"to,omitempty"`
	Blockers []Blocker `json:"blockers,omitempty"`
}

// TrackPoint is one entry of a train trajectory.
type TrackPoint struct {
	Tick int `json:"tick"`
	Pos  int `json:"pos"`
}

// Train is a single train on the line.
type Train struct {
	ID        string
	Pos       int
	Brake     int // braking distance, in sections
	Reserved  map[int]bool
	Waiting   bool
	WaitSince int
	Faulty    bool
	Arrived   bool
	Traj      []TrackPoint
}

// Sim is the simulation state.
type Sim struct {
	Tick        int
	NumSections int

	trains     map[string]*Train
	Occupant   []string // occupant per section, "" if free
	ReservedBy []string // reservation holder per section, "" if free

	Events []Event

	faults map[int][]string // scheduled faults: tick -> train IDs
}

// New creates a simulation over numSections sections, indexed 0..n-1.
func New(numSections int) *Sim {
	if numSections < 1 {
		panic("sim: need at least one section")
	}
	return &Sim{
		NumSections: numSections,
		trains:      make(map[string]*Train),
		Occupant:    make([]string, numSections),
		ReservedBy:  make([]string, numSections),
		faults:      make(map[int][]string),
	}
}

// AddTrain places a train at pos with the given braking distance.
func (s *Sim) AddTrain(id string, pos, brake int) error {
	if id == "" {
		return fmt.Errorf("sim: empty train id")
	}
	if _, dup := s.trains[id]; dup {
		return fmt.Errorf("sim: duplicate train id %q", id)
	}
	if pos < 0 || pos >= s.NumSections {
		return fmt.Errorf("sim: train %s position %d out of range", id, pos)
	}
	if brake < 1 {
		return fmt.Errorf("sim: train %s braking distance must be >= 1", id)
	}
	if s.Occupant[pos] != "" {
		return fmt.Errorf("sim: section %d already occupied by %s", pos, s.Occupant[pos])
	}
	t := &Train{
		ID:       id,
		Pos:      pos,
		Brake:    brake,
		Reserved: make(map[int]bool),
		Traj:     []TrackPoint{{Tick: s.Tick, Pos: pos}},
	}
	s.trains[id] = t
	s.Occupant[pos] = id
	return nil
}

// ScheduleFault makes the train break down at the start of the given tick.
func (s *Sim) ScheduleFault(tick int, id string) {
	s.faults[tick] = append(s.faults[tick], id)
}

// Train returns the train with the given id, or nil.
func (s *Sim) Train(id string) *Train { return s.trains[id] }

// Trains returns all trains sorted by ID.
func (s *Sim) Trains() []*Train {
	out := make([]*Train, 0, len(s.trains))
	for _, t := range s.trains {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Rejections returns all rejection events (the refusal evidence).
func (s *Sim) Rejections() []Event {
	var out []Event
	for _, e := range s.Events {
		if e.Type == EventReject {
			out = append(out, e)
		}
	}
	return out
}

func (s *Sim) emit(e Event) {
	e.Tick = s.Tick
	s.Events = append(s.Events, e)
}

// needSections returns the sections a train must hold before it may enter
// the next section: [pos+1, pos+brake], clipped to the line.
func (s *Sim) needSections(t *Train) []int {
	last := t.Pos + t.Brake
	if last > s.NumSections-1 {
		last = s.NumSections - 1
	}
	need := make([]int, 0, last-t.Pos)
	for sec := t.Pos + 1; sec <= last; sec++ {
		need = append(need, sec)
	}
	return need
}

// Step advances the simulation by one tick.
func (s *Sim) Step() {
	s.Tick++
	for _, id := range s.faults[s.Tick] {
		s.applyFault(id)
	}
	var cands []*Train
	for _, t := range s.trains {
		if !t.Faulty && !t.Arrived {
			cands = append(cands, t)
		}
	}
	// Conflict resolution: earliest waiter first, ties broken by train ID.
	sort.Slice(cands, func(i, j int) bool {
		wi, wj := s.effWait(cands[i]), s.effWait(cands[j])
		if wi != wj {
			return wi < wj
		}
		return cands[i].ID < cands[j].ID
	})
	for _, t := range cands {
		s.attempt(t)
	}
}

func (s *Sim) effWait(t *Train) int {
	if t.Waiting {
		return t.WaitSince
	}
	return s.Tick
}

// attempt tries to reserve the braking window ahead of t and move it one
// section forward. On failure it records a rejection with evidence.
func (s *Sim) attempt(t *Train) {
	if t.Pos+1 >= s.NumSections {
		s.arrive(t)
		return
	}
	need := s.needSections(t)
	var blockers []Blocker
	for _, sec := range need {
		if occ := s.Occupant[sec]; occ != "" && occ != t.ID {
			blockers = append(blockers, Blocker{Section: sec, Occupant: occ})
		} else if r := s.ReservedBy[sec]; r != "" && r != t.ID {
			blockers = append(blockers, Blocker{Section: sec, ReservedBy: r})
		}
	}
	if len(blockers) > 0 {
		if !t.Waiting {
			t.Waiting = true
			t.WaitSince = s.Tick
		}
		s.emit(Event{Type: EventReject, Train: t.ID, Sections: need, Blockers: blockers})
		return
	}
	var granted []int
	for _, sec := range need {
		if !t.Reserved[sec] {
			t.Reserved[sec] = true
			s.ReservedBy[sec] = t.ID
			granted = append(granted, sec)
		}
	}
	if len(granted) > 0 {
		s.emit(Event{Type: EventGrant, Train: t.ID, Sections: granted})
	}
	// Release reservations left behind.
	var released []int
	for sec := range t.Reserved {
		if sec <= t.Pos {
			released = append(released, sec)
			delete(t.Reserved, sec)
			if s.ReservedBy[sec] == t.ID {
				s.ReservedBy[sec] = ""
			}
		}
	}
	if len(released) > 0 {
		sort.Ints(released)
		s.emit(Event{Type: EventRelease, Train: t.ID, Sections: released})
	}
	from := t.Pos
	s.Occupant[from] = ""
	t.Pos = from + 1
	s.Occupant[t.Pos] = t.ID
	t.Waiting = false
	t.Traj = append(t.Traj, TrackPoint{Tick: s.Tick, Pos: t.Pos})
	s.emit(Event{Type: EventMove, Train: t.ID, From: from, To: t.Pos})
}

// arrive removes a train that has reached the end of the line.
func (s *Sim) arrive(t *Train) {
	released := t.releaseAll(s)
	if len(released) > 0 {
		s.emit(Event{Type: EventRelease, Train: t.ID, Sections: released})
	}
	s.Occupant[t.Pos] = ""
	t.Arrived = true
	t.Waiting = false
	s.emit(Event{Type: EventArrive, Train: t.ID, From: t.Pos})
}

// applyFault breaks a train down: it keeps occupying its current section
// forever and drops its forward reservations.
func (s *Sim) applyFault(id string) {
	t := s.trains[id]
	if t == nil || t.Faulty || t.Arrived {
		return
	}
	t.Faulty = true
	t.Waiting = false
	released := t.releaseAll(s)
	if len(released) > 0 {
		s.emit(Event{Type: EventRelease, Train: t.ID, Sections: released})
	}
	s.emit(Event{Type: EventFault, Train: t.ID, Sections: []int{t.Pos}})
}

func (t *Train) releaseAll(s *Sim) []int {
	var released []int
	for sec := range t.Reserved {
		released = append(released, sec)
		delete(t.Reserved, sec)
		if s.ReservedBy[sec] == t.ID {
			s.ReservedBy[sec] = ""
		}
	}
	sort.Ints(released)
	return released
}

// Verify checks the mutual-exclusion invariants: no section is occupied by
// more than one train, no section is reserved by more than one train, no
// reservation overlaps another train's occupancy, and a faulty train still
// holds its section. It cross-checks the per-section tables against the
// per-train state.
func (s *Sim) Verify() error {
	occ := make([]string, s.NumSections)
	for _, t := range s.trains {
		if t.Arrived {
			continue
		}
		if t.Pos < 0 || t.Pos >= s.NumSections {
			return fmt.Errorf("train %s position %d out of range", t.ID, t.Pos)
		}
		if occ[t.Pos] != "" {
			return fmt.Errorf("duplicate occupancy of section %d by %s and %s", t.Pos, occ[t.Pos], t.ID)
		}
		occ[t.Pos] = t.ID
		if t.Faulty && s.Occupant[t.Pos] != t.ID {
			return fmt.Errorf("faulty train %s does not hold section %d", t.ID, t.Pos)
		}
	}
	for i := range occ {
		if occ[i] != s.Occupant[i] {
			return fmt.Errorf("occupancy table mismatch at section %d: table=%q derived=%q", i, s.Occupant[i], occ[i])
		}
	}
	res := make([]string, s.NumSections)
	for _, t := range s.trains {
		for sec := range t.Reserved {
			if sec < 0 || sec >= s.NumSections {
				return fmt.Errorf("train %s reserves section %d out of range", t.ID, sec)
			}
			if res[sec] != "" {
				return fmt.Errorf("duplicate reservation of section %d by %s and %s", sec, res[sec], t.ID)
			}
			if occ[sec] != "" && occ[sec] != t.ID {
				return fmt.Errorf("train %s reserves section %d occupied by %s", t.ID, sec, occ[sec])
			}
			res[sec] = t.ID
		}
	}
	for i := range res {
		if res[i] != s.ReservedBy[i] {
			return fmt.Errorf("reservation table mismatch at section %d: table=%q derived=%q", i, s.ReservedBy[i], res[i])
		}
	}
	return nil
}
