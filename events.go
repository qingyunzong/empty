package trainsim

import (
	"encoding/json"
	"fmt"
)

// Event types recorded in the simulation trajectory.
const (
	EventEnter   = "enter"
	EventExit    = "exit"
	EventReserve = "reserve"
	EventReject  = "reject"
	EventFault   = "fault"
	EventArrive  = "arrive"
)

// RejectionEvidence explains why a reservation request was denied.
type RejectionEvidence struct {
	Tick               int    `json:"tick"`
	TrainID            int    `json:"train_id"`
	Requested          []int  `json:"requested"`
	BlockedSection     int    `json:"blocked_section"`
	Holder             int    `json:"holder"`
	HolderState        string `json:"holder_state"`
	RequesterWaitSince int    `json:"requester_wait_since"`
	HolderWaitSince    int    `json:"holder_wait_since"`
	Reason             string `json:"reason"`
}

// Event is a single entry in the simulation trajectory.
type Event struct {
	Tick     int                `json:"tick"`
	Type     string             `json:"type"`
	TrainID  int                `json:"train_id"`
	Section  int                `json:"section,omitempty"`
	Evidence *RejectionEvidence `json:"evidence,omitempty"`
}

func (e Event) String() string {
	if e.Type == EventReject && e.Evidence != nil {
		ev := e.Evidence
		return fmt.Sprintf("tick=%d REJECT train=%d needs=%v blocked=section%d holder=train%d(%s,wait@%d) requester wait@%d",
			e.Tick, e.TrainID, ev.Requested, ev.BlockedSection,
			ev.Holder, ev.HolderState, ev.HolderWaitSince, ev.RequesterWaitSince)
	}
	return fmt.Sprintf("tick=%d %-7s train=%d section=%d", e.Tick, e.Type, e.TrainID, e.Section)
}

// Snapshot is a recoverable view of section occupancy and reservations.
type Snapshot struct {
	Tick         int         `json:"tick"`
	Occupancy    map[int]int `json:"occupancy"`
	Reservations map[int]int `json:"reservations"`
}

// Snapshot captures the current occupancy and reservation maps.
func (s *Sim) Snapshot() Snapshot {
	snap := Snapshot{
		Tick:         s.Tick,
		Occupancy:    map[int]int{},
		Reservations: map[int]int{},
	}
	for sec, id := range s.Occupancy {
		snap.Occupancy[sec] = id
	}
	for sec, id := range s.Reservations {
		snap.Reservations[sec] = id
	}
	return snap
}

// VerifyEvents replays the trajectory and fails if any section is ever
// occupied by two trains at the same time (duplicate occupancy).
func VerifyEvents(events []Event) error {
	occ := map[int]int{}
	for _, e := range events {
		switch e.Type {
		case EventEnter:
			if prev, ok := occ[e.Section]; ok && prev != e.TrainID {
				return fmt.Errorf("tick %d: duplicate occupancy of section %d: train %d enters while train %d still occupies it",
					e.Tick, e.Section, e.TrainID, prev)
			}
			occ[e.Section] = e.TrainID
		case EventExit:
			if occ[e.Section] == e.TrainID {
				delete(occ, e.Section)
			}
		}
	}
	return nil
}

// Recover rebuilds a Snapshot by replaying the event log, after verifying the
// log contains no duplicate section occupancy.
func Recover(events []Event) (Snapshot, error) {
	if err := VerifyEvents(events); err != nil {
		return Snapshot{}, err
	}
	snap := Snapshot{Occupancy: map[int]int{}}
	for _, e := range events {
		switch e.Type {
		case EventEnter:
			snap.Occupancy[e.Section] = e.TrainID
		case EventExit:
			if snap.Occupancy[e.Section] == e.TrainID {
				delete(snap.Occupancy, e.Section)
			}
		}
		if e.Tick > snap.Tick {
			snap.Tick = e.Tick
		}
	}
	return snap, nil
}

// MarshalEvents serializes the trajectory for persistence.
func MarshalEvents(events []Event) ([]byte, error) {
	return json.MarshalIndent(events, "", "  ")
}

// UnmarshalEvents loads a persisted trajectory.
func UnmarshalEvents(data []byte) ([]Event, error) {
	var events []Event
	if err := json.Unmarshal(data, &events); err != nil {
		return nil, err
	}
	return events, nil
}
