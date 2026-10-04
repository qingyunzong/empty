package trafficsim

// Snapshot returns a deep copy of the whole simulation state. Continuing
// either the original or the snapshot yields identical trajectories, and
// the two copies share no mutable state.
func (s *Sim) Snapshot() *Sim {
	cp := &Sim{
		TickCount:            s.TickCount,
		Segments:             make([]*Segment, len(s.Segments)),
		Vehicles:             make([]*Vehicle, len(s.Vehicles)),
		Intersections:        make([]*Intersection, len(s.Intersections)),
		CrossingLog:          append([]Crossing(nil), s.CrossingLog...),
		movementIntersection: make(map[Movement]int, len(s.movementIntersection)),
	}
	for i, seg := range s.Segments {
		c := *seg
		cp.Segments[i] = &c
	}
	for i, v := range s.Vehicles {
		c := *v
		c.Route = append([]SegmentID(nil), v.Route...)
		cp.Vehicles[i] = &c
	}
	for i, ix := range s.Intersections {
		cp.Intersections[i] = &Intersection{ID: ix.ID, Conflicts: ix.Conflicts.clone()}
	}
	for m, id := range s.movementIntersection {
		cp.movementIntersection[m] = id
	}
	return cp
}
