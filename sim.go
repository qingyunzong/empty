// Package trafficsim is a deterministic, tick-based traffic simulation
// library. Vehicles travel along routes of capacity-limited road segments
// and cross intersections governed by a public mutual-exclusion conflict
// table. Each tick releases finished vehicles first, then grants pending
// entry requests ordered by waiting time (longest first) and vehicle ID
// (smallest first). A vehicle's tail keeps occupying the previous segment
// until the whole vehicle has left it.
package trafficsim

import "sort"

// SegmentID identifies a road segment within a Sim.
type SegmentID int

// VehicleID identifies a vehicle within a Sim.
type VehicleID int

// SpawnFrom is the virtual origin segment of a vehicle entering the network.
const SpawnFrom SegmentID = -1

// Movement is a turn from one segment to another across an intersection.
type Movement struct {
	From SegmentID
	To   SegmentID
}

// ConflictTable is the public mutual-exclusion table of an intersection:
// two conflicting movements may not be granted in the same tick.
type ConflictTable struct {
	pairs map[Movement]map[Movement]bool
}

// NewConflictTable returns an empty conflict table.
func NewConflictTable() *ConflictTable {
	return &ConflictTable{pairs: make(map[Movement]map[Movement]bool)}
}

// Add records a symmetric mutual-exclusion conflict between a and b.
func (c *ConflictTable) Add(a, b Movement) {
	if c.pairs[a] == nil {
		c.pairs[a] = make(map[Movement]bool)
	}
	c.pairs[a][b] = true
	if c.pairs[b] == nil {
		c.pairs[b] = make(map[Movement]bool)
	}
	c.pairs[b][a] = true
}

// Conflicts reports whether movements a and b are mutually exclusive.
// A nil table conflicts with nothing.
func (c *ConflictTable) Conflicts(a, b Movement) bool {
	if c == nil {
		return false
	}
	return c.pairs[a][b]
}

func (c *ConflictTable) clone() *ConflictTable {
	cp := NewConflictTable()
	for m, set := range c.pairs {
		cp.pairs[m] = make(map[Movement]bool, len(set))
		for other, v := range set {
			cp.pairs[m][other] = v
		}
	}
	return cp
}

// Segment is a stretch of road with a travel length, a per-tick speed and
// a capacity counted in vehicles (a vehicle counts against every segment
// its body still touches, including the previous one via its tail).
type Segment struct {
	ID       SegmentID
	Length   float64
	Speed    float64
	Capacity int
}

// Intersection connects segments; its Conflicts table is public so callers
// can inspect or extend the mutual-exclusion rules.
type Intersection struct {
	ID        int
	Conflicts *ConflictTable
}

// Vehicle travels a route of segments. Position is the front-bumper
// distance along the current segment; while Position < Length the tail
// still occupies the previous segment.
type Vehicle struct {
	ID         VehicleID
	Route      []SegmentID
	RouteIndex int
	Position   float64
	Length     float64
	WaitTicks  int
	SpawnTick  int
	Entered    bool
	Arrived    bool
}

// Crossing records one granted movement, for collision-freedom evidence.
type Crossing struct {
	Tick         int
	Intersection int // -1 for movements not bound to an intersection
	Vehicle      VehicleID
	Movement     Movement
}

// Sim is a deterministic traffic simulation. All iteration order is fixed
// (vehicle ID order, intersection ID order), so identical inputs always
// produce identical trajectories.
type Sim struct {
	TickCount     int
	Segments      []*Segment
	Vehicles      []*Vehicle
	Intersections []*Intersection
	CrossingLog   []Crossing

	movementIntersection map[Movement]int
}

// NewSim returns an empty simulation.
func NewSim() *Sim {
	return &Sim{movementIntersection: make(map[Movement]int)}
}

// AddSegment appends a segment and returns its ID.
func (s *Sim) AddSegment(length, speed float64, capacity int) SegmentID {
	id := SegmentID(len(s.Segments))
	s.Segments = append(s.Segments, &Segment{ID: id, Length: length, Speed: speed, Capacity: capacity})
	return id
}

// AddIntersection appends an intersection with an empty conflict table.
func (s *Sim) AddIntersection() *Intersection {
	ix := &Intersection{ID: len(s.Intersections), Conflicts: NewConflictTable()}
	s.Intersections = append(s.Intersections, ix)
	return ix
}

// Connect binds a movement to an intersection so its conflict table applies.
func (s *Sim) Connect(ix *Intersection, from, to SegmentID) {
	s.movementIntersection[Movement{From: from, To: to}] = ix.ID
}

// AddVehicle appends a vehicle that will request entry to route[0] at
// SpawnTick, and returns its ID.
func (s *Sim) AddVehicle(route []SegmentID, length float64, spawnTick int) VehicleID {
	id := VehicleID(len(s.Vehicles))
	s.Vehicles = append(s.Vehicles, &Vehicle{
		ID:        id,
		Route:     append([]SegmentID(nil), route...),
		Length:    length,
		SpawnTick: spawnTick,
	})
	return id
}

// vehicleOccupies reports whether v's body touches seg, including a tail
// that has not yet left the previous segment.
func vehicleOccupies(v *Vehicle, seg SegmentID) bool {
	if !v.Entered || v.Arrived {
		return false
	}
	if v.Route[v.RouteIndex] == seg {
		return true
	}
	return v.RouteIndex > 0 && v.Route[v.RouteIndex-1] == seg && v.Position < v.Length
}

// Occupancy counts the vehicles currently occupying seg.
func (s *Sim) Occupancy(seg SegmentID) int {
	n := 0
	for _, v := range s.Vehicles {
		if vehicleOccupies(v, seg) {
			n++
		}
	}
	return n
}

// Tick advances the simulation one step: release, move, then grant.
func (s *Sim) Tick() {
	s.TickCount++
	s.release()
	s.move()
	s.grant()
}

// release removes vehicles whose front reached the end of their last
// segment, freeing the capacity they held before any grant this tick.
func (s *Sim) release() {
	for _, v := range s.Vehicles {
		if !v.Entered || v.Arrived {
			continue
		}
		seg := s.Segments[v.Route[v.RouteIndex]]
		if v.RouteIndex == len(v.Route)-1 && v.Position >= seg.Length {
			v.Arrived = true
		}
	}
}

// move advances every entered vehicle that is not waiting at a segment end.
func (s *Sim) move() {
	for _, v := range s.Vehicles {
		if !v.Entered || v.Arrived {
			continue
		}
		seg := s.Segments[v.Route[v.RouteIndex]]
		if v.Position < seg.Length {
			v.Position += seg.Speed
			if v.Position > seg.Length {
				v.Position = seg.Length
			}
		}
	}
}

type grantRequest struct {
	vehicle  *Vehicle
	movement Movement
}

// grant processes entry requests intersection by intersection (ID order).
// Within one intersection, requests are ordered by waiting time (longest
// first), ties broken by vehicle ID (smallest first). A request is granted
// only if the target segment has free capacity and its movement does not
// conflict with any movement already granted this tick.
func (s *Sim) grant() {
	groups := make(map[int][]grantRequest)
	for _, v := range s.Vehicles {
		if v.Arrived {
			continue
		}
		var m Movement
		if !v.Entered {
			if v.SpawnTick > s.TickCount {
				continue
			}
			m = Movement{From: SpawnFrom, To: v.Route[0]}
		} else {
			seg := s.Segments[v.Route[v.RouteIndex]]
			if v.RouteIndex+1 >= len(v.Route) || v.Position < seg.Length {
				continue
			}
			m = Movement{From: seg.ID, To: v.Route[v.RouteIndex+1]}
		}
		ixID := -1
		if id, ok := s.movementIntersection[m]; ok {
			ixID = id
		}
		groups[ixID] = append(groups[ixID], grantRequest{vehicle: v, movement: m})
	}

	ixIDs := make([]int, 0, len(groups))
	for id := range groups {
		ixIDs = append(ixIDs, id)
	}
	sort.Ints(ixIDs)

	for _, ixID := range ixIDs {
		reqs := groups[ixID]
		sort.Slice(reqs, func(i, j int) bool {
			a, b := reqs[i].vehicle, reqs[j].vehicle
			if a.WaitTicks != b.WaitTicks {
				return a.WaitTicks > b.WaitTicks
			}
			return a.ID < b.ID
		})
		var table *ConflictTable
		if ixID >= 0 {
			table = s.Intersections[ixID].Conflicts
		}
		var granted []Movement
		for _, req := range reqs {
			v := req.vehicle
			target := s.Segments[req.movement.To]
			if s.Occupancy(target.ID) >= target.Capacity {
				v.WaitTicks++
				continue
			}
			conflict := false
			for _, g := range granted {
				if table.Conflicts(g, req.movement) {
					conflict = true
					break
				}
			}
			if conflict {
				v.WaitTicks++
				continue
			}
			granted = append(granted, req.movement)
			if !v.Entered {
				v.Entered = true
				v.RouteIndex = 0
			} else {
				v.RouteIndex++
			}
			v.Position = 0
			v.WaitTicks = 0
			s.CrossingLog = append(s.CrossingLog, Crossing{
				Tick:         s.TickCount,
				Intersection: ixID,
				Vehicle:      v.ID,
				Movement:     req.movement,
			})
		}
	}
}
