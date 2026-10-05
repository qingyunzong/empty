// Package trainsim implements a discrete-time depot train simulation with
// mutually exclusive sections, braking-distance reservations, priority-based
// conflict resolution, and faulted trains that never release their section.
package trainsim

import (
	"fmt"
	"sort"
)

// TrainState is the lifecycle state of a train.
type TrainState int

const (
	StateRunning TrainState = iota
	StateWaiting
	StateFaulted
	StateArrived
)

func (s TrainState) String() string {
	switch s {
	case StateRunning:
		return "Running"
	case StateWaiting:
		return "Waiting"
	case StateFaulted:
		return "Faulted"
	case StateArrived:
		return "Arrived"
	}
	return "Unknown"
}

// Train travels along Route (an ordered list of section IDs). Before entering
// the next section it must hold reservations for every section within
// BrakeDist sections ahead.
type Train struct {
	ID        int
	Route     []int
	Pos       int // index into Route; the train physically occupies Route[Pos]
	BrakeDist int
	State     TrainState
	WaitSince int // tick the current move request first became pending
	FaultAt   int // tick at which the train faults; -1 disables
}

// NewTrain creates a train placed at the first section of its route.
func NewTrain(id int, route []int, brakeDist int) *Train {
	return &Train{ID: id, Route: route, BrakeDist: brakeDist, FaultAt: -1}
}

// Section returns the section the train currently occupies.
func (t *Train) Section() int { return t.Route[t.Pos] }

// neededSections returns the sections that must all be reserved before the
// train may enter the next section: every section within braking distance
// ahead, clamped to the end of the route.
func (t *Train) neededSections() []int {
	end := t.Pos + t.BrakeDist
	if end > len(t.Route)-1 {
		end = len(t.Route) - 1
	}
	need := make([]int, 0, end-t.Pos)
	for i := t.Pos + 1; i <= end; i++ {
		need = append(need, t.Route[i])
	}
	return need
}

// Sim is the simulation state.
type Sim struct {
	Tick         int
	Trains       []*Train
	Reservations map[int]int // section -> owning train
	Occupancy    map[int]int // section -> physically occupying train
	Events       []Event
}

// NewSim builds a simulation with all trains placed at the first section of
// their routes at tick 0.
func NewSim(trains ...*Train) *Sim {
	s := &Sim{
		Trains:       trains,
		Reservations: map[int]int{},
		Occupancy:    map[int]int{},
	}
	for _, t := range trains {
		sec := t.Section()
		s.Occupancy[sec] = t.ID
		s.Reservations[sec] = t.ID
		s.emit(Event{Type: EventEnter, TrainID: t.ID, Section: sec})
	}
	return s
}

func (s *Sim) emit(e Event) {
	e.Tick = s.Tick
	s.Events = append(s.Events, e)
}

func (s *Sim) trainByID(id int) *Train {
	for _, t := range s.Trains {
		if t.ID == id {
			return t
		}
	}
	return nil
}

// Step advances the simulation by one tick.
func (s *Sim) Step() {
	s.Tick++
	s.applyFaults()
	for _, t := range s.sortedCandidates() {
		s.tryMove(t)
	}
}

// Run advances until every train has arrived or faulted, or maxTicks is hit.
func (s *Sim) Run(maxTicks int) {
	for s.Tick < maxTicks && !s.AllDone() {
		s.Step()
	}
}

// AllDone reports whether no train can still move.
func (s *Sim) AllDone() bool {
	for _, t := range s.Trains {
		if t.State != StateArrived && t.State != StateFaulted {
			return false
		}
	}
	return true
}

// applyFaults faults trains scheduled for this tick. A faulted train keeps
// occupying its current section forever; only its forward reservations are
// released.
func (s *Sim) applyFaults() {
	for _, t := range s.Trains {
		if t.FaultAt != s.Tick || t.State == StateFaulted || t.State == StateArrived {
			continue
		}
		t.State = StateFaulted
		cur := t.Section()
		for sec, owner := range s.Reservations {
			if owner == t.ID && sec != cur {
				delete(s.Reservations, sec)
			}
		}
		s.emit(Event{Type: EventFault, TrainID: t.ID, Section: cur})
	}
}

// sortedCandidates returns trains that still want to move, ordered by
// conflict priority: earliest waiting first, ties broken by smaller ID.
func (s *Sim) sortedCandidates() []*Train {
	var cands []*Train
	for _, t := range s.Trains {
		if t.State == StateArrived || t.State == StateFaulted {
			continue
		}
		if t.Pos >= len(t.Route)-1 {
			continue
		}
		cands = append(cands, t)
	}
	sort.Slice(cands, func(i, j int) bool {
		if cands[i].WaitSince != cands[j].WaitSince {
			return cands[i].WaitSince < cands[j].WaitSince
		}
		return cands[i].ID < cands[j].ID
	})
	return cands
}

// firstBlocker returns the first needed section reserved by another train.
func (s *Sim) firstBlocker(t *Train, need []int) (section, holder int) {
	for _, sec := range need {
		if owner, ok := s.Reservations[sec]; ok && owner != t.ID {
			return sec, owner
		}
	}
	return -1, -1
}

// tryMove grants reservations and advances the train if every section within
// braking distance is reservable; otherwise it records a rejection with
// evidence.
func (s *Sim) tryMove(t *Train) {
	need := t.neededSections()
	blocker, holder := s.firstBlocker(t, need)
	if blocker >= 0 {
		t.State = StateWaiting
		s.emit(Event{
			Type:     EventReject,
			TrainID:  t.ID,
			Section:  blocker,
			Evidence: s.newEvidence(t, need, blocker, holder),
		})
		return
	}
	for _, sec := range need {
		s.Reservations[sec] = t.ID
		s.emit(Event{Type: EventReserve, TrainID: t.ID, Section: sec})
	}
	old := t.Section()
	delete(s.Occupancy, old)
	if s.Reservations[old] == t.ID {
		delete(s.Reservations, old)
	}
	s.emit(Event{Type: EventExit, TrainID: t.ID, Section: old})
	t.Pos++
	cur := t.Section()
	s.Occupancy[cur] = t.ID
	s.Reservations[cur] = t.ID
	s.emit(Event{Type: EventEnter, TrainID: t.ID, Section: cur})
	t.State = StateRunning
	t.WaitSince = s.Tick
	if t.Pos == len(t.Route)-1 {
		t.State = StateArrived
		delete(s.Occupancy, cur)
		for sec, owner := range s.Reservations {
			if owner == t.ID {
				delete(s.Reservations, sec)
			}
		}
		s.emit(Event{Type: EventExit, TrainID: t.ID, Section: cur})
		s.emit(Event{Type: EventArrive, TrainID: t.ID, Section: cur})
	}
}

// newEvidence builds the rejection evidence explaining why the request was
// denied, including the priority comparison against the current holder.
func (s *Sim) newEvidence(t *Train, need []int, blocker, holder int) *RejectionEvidence {
	ev := &RejectionEvidence{
		Tick:               s.Tick,
		TrainID:            t.ID,
		Requested:          append([]int(nil), need...),
		BlockedSection:     blocker,
		Holder:             holder,
		RequesterWaitSince: t.WaitSince,
	}
	if ht := s.trainByID(holder); ht != nil {
		ev.HolderWaitSince = ht.WaitSince
		ev.HolderState = ht.State.String()
	}
	ev.Reason = fmt.Sprintf(
		"section %d reserved by train %d (%s, waiting since tick %d); requester train %d waiting since tick %d loses by wait-time-then-ID priority",
		ev.BlockedSection, ev.Holder, ev.HolderState, ev.HolderWaitSince,
		ev.TrainID, ev.RequesterWaitSince)
	return ev
}
