package trafficsim

import (
	"bytes"
	"encoding/gob"
	"fmt"
)

// snapshot is the serialized form of the complete simulation state.
type snapshot struct {
	Tick     int
	Spawned  int
	Finished int
	Grants   []VehicleID
	Segments []Segment
	Vehicles []Vehicle
	Allows   []allowEntry
}

// Snapshot encodes the full simulation state into bytes. Restoring from
// those bytes and continuing the run produces a trajectory identical to
// an uninterrupted run.
func (s *Sim) Snapshot() []byte {
	snap := snapshot{
		Tick:     s.Tick,
		Spawned:  s.Spawned,
		Finished: s.Finished,
		Grants:   append([]VehicleID(nil), s.Grants...),
		Allows:   s.Conflicts.entries(),
	}
	for _, id := range s.sortedSegmentIDs() {
		snap.Segments = append(snap.Segments, *s.Segments[id])
	}
	for _, id := range s.sortedVehicleIDs() {
		v := s.Vehicles[id]
		snap.Vehicles = append(snap.Vehicles, Vehicle{
			ID:        v.ID,
			Route:     append([]SegmentID(nil), v.Route...),
			HeadRoute: v.HeadRoute,
			Cells:     append([]Cell(nil), v.Cells...),
			Wait:      v.Wait,
		})
	}
	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(snap); err != nil {
		panic(fmt.Sprintf("trafficsim: snapshot encode: %v", err))
	}
	return buf.Bytes()
}

// Restore rebuilds a simulation from Snapshot bytes. The occupancy index
// is reconstructed from the vehicle cells.
func Restore(data []byte) (*Sim, error) {
	var snap snapshot
	if err := gob.NewDecoder(bytes.NewReader(data)).Decode(&snap); err != nil {
		return nil, fmt.Errorf("trafficsim: restore: %w", err)
	}
	s := NewSim()
	s.Tick = snap.Tick
	s.Spawned = snap.Spawned
	s.Finished = snap.Finished
	s.Grants = append([]VehicleID(nil), snap.Grants...)
	for i := range snap.Segments {
		seg := snap.Segments[i]
		s.Segments[seg.ID] = &seg
	}
	for i := range snap.Vehicles {
		v := snap.Vehicles[i]
		vc := v
		s.Vehicles[v.ID] = &vc
		for _, c := range v.Cells {
			if _, taken := s.occ[c]; taken {
				return nil, fmt.Errorf("trafficsim: restore: cell %v occupied twice", c)
			}
			s.occ[c] = v.ID
		}
	}
	for _, e := range snap.Allows {
		s.Conflicts.Allow(e.Node, e.A, e.B)
	}
	return s, nil
}

func (s *Sim) sortedSegmentIDs() []SegmentID {
	ids := make([]SegmentID, 0, len(s.Segments))
	for id := range s.Segments {
		ids = append(ids, id)
	}
	for i := 1; i < len(ids); i++ {
		for j := i; j > 0 && ids[j] < ids[j-1]; j-- {
			ids[j], ids[j-1] = ids[j-1], ids[j]
		}
	}
	return ids
}
