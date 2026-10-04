package trafficsim

import "sort"

// WaitForGraph builds the capacity wait-for graph: an edge v -> w means
// vehicle v is requesting a segment that is full, and vehicle w is one of
// its occupants (counting tails still on the segment). A cycle in this
// graph is a gridlock deadlock: every vehicle in the cycle waits for
// capacity held by the previous one.
func (s *Sim) WaitForGraph() map[VehicleID][]VehicleID {
	g := make(map[VehicleID][]VehicleID)
	for _, v := range s.Vehicles {
		target, blocked := s.blockedOn(v)
		if !blocked {
			continue
		}
		if s.Occupancy(target) < s.Segments[target].Capacity {
			continue
		}
		for _, w := range s.Vehicles {
			if w.ID != v.ID && vehicleOccupies(w, target) {
				g[v.ID] = append(g[v.ID], w.ID)
			}
		}
		sort.Slice(g[v.ID], func(i, j int) bool { return g[v.ID][i] < g[v.ID][j] })
	}
	return g
}

// blockedOn returns the segment v currently requests entry to, if any.
func (s *Sim) blockedOn(v *Vehicle) (SegmentID, bool) {
	if v.Arrived {
		return 0, false
	}
	if !v.Entered {
		if v.SpawnTick <= s.TickCount {
			return v.Route[0], true
		}
		return 0, false
	}
	if v.RouteIndex+1 >= len(v.Route) {
		return 0, false
	}
	seg := s.Segments[v.Route[v.RouteIndex]]
	if v.Position >= seg.Length {
		return v.Route[v.RouteIndex+1], true
	}
	return 0, false
}

// FindDeadlockCycle returns one cycle of the wait-for graph as evidence of
// a deadlock, or nil if the graph is acyclic. The cycle lists vehicle IDs
// in wait-for order: each vehicle waits for the next, and the last waits
// for the first. Traversal order is deterministic (ascending vehicle ID).
func (s *Sim) FindDeadlockCycle() []VehicleID {
	g := s.WaitForGraph()
	const (
		white = iota // unvisited
		gray         // on the current DFS stack
		black        // fully explored
	)
	color := make(map[VehicleID]int, len(s.Vehicles))
	var stack []VehicleID
	var cycle []VehicleID

	var dfs func(v VehicleID) bool
	dfs = func(v VehicleID) bool {
		color[v] = gray
		stack = append(stack, v)
		for _, w := range g[v] {
			switch color[w] {
			case gray:
				start := 0
				for i, id := range stack {
					if id == w {
						start = i
						break
					}
				}
				cycle = append([]VehicleID(nil), stack[start:]...)
				return true
			case white:
				if dfs(w) {
					return true
				}
			}
		}
		stack = stack[:len(stack)-1]
		color[v] = black
		return false
	}

	for _, v := range s.Vehicles {
		if color[v.ID] == white && dfs(v.ID) {
			return cycle
		}
	}
	return nil
}
