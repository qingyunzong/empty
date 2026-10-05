// Package trafficsim is a deterministic, tick-based traffic simulation
// library. Vehicles travel along routes of connected road segments and
// occupy individual cells; a vehicle's tail keeps occupying capacity on a
// segment until the tail itself leaves. Crossings at intersections are
// arbitrated per tick: releases happen first, then waiting vehicles are
// granted entry ordered by waiting duration (longest first), ties broken
// by smaller vehicle ID, subject to a public mutual-exclusion conflict
// table. Only the Go standard library is used.
package trafficsim

import (
	"fmt"
	"sort"
	"strings"
)

type NodeID int
type SegmentID int
type VehicleID int

// Cell is a single capacity unit on a segment.
type Cell struct {
	Seg SegmentID
	Idx int
}

// Movement is a crossing from one segment into the next at a shared node.
type Movement struct {
	From SegmentID
	To   SegmentID
}

// Segment is a directed road piece between two nodes with Length cells.
type Segment struct {
	ID     SegmentID
	From   NodeID
	To     NodeID
	Length int
}

// Vehicle is a train of occupied cells; Cells[0] is the head and
// Cells[len-1] is the tail.
type Vehicle struct {
	ID        VehicleID
	Route     []SegmentID
	HeadRoute int // index into Route of the segment holding the head cell
	Cells     []Cell
	Wait      int // consecutive ticks spent waiting to enter the next segment
}

// Length returns the vehicle length in cells.
func (v *Vehicle) Length() int { return len(v.Cells) }

// Sim is the whole simulation state. It is deterministic: every decision
// depends only on the state, never on map iteration order or randomness.
type Sim struct {
	Segments  map[SegmentID]*Segment
	Vehicles  map[VehicleID]*Vehicle
	Conflicts *ConflictTable

	Tick     int
	Spawned  int
	Finished int

	// Grants lists the vehicles granted a crossing in the most recent Step.
	Grants []VehicleID

	occ map[Cell]VehicleID
}

func NewSim() *Sim {
	return &Sim{
		Segments:  make(map[SegmentID]*Segment),
		Vehicles:  make(map[VehicleID]*Vehicle),
		Conflicts: NewConflictTable(),
		occ:       make(map[Cell]VehicleID),
	}
}

func (s *Sim) AddSegment(id SegmentID, from, to NodeID, length int) error {
	if length < 1 {
		return fmt.Errorf("segment %d: length must be >= 1", id)
	}
	if _, dup := s.Segments[id]; dup {
		return fmt.Errorf("segment %d: duplicate", id)
	}
	s.Segments[id] = &Segment{ID: id, From: from, To: to, Length: length}
	return nil
}

// Spawn places a vehicle at the start of its route. The whole vehicle must
// fit at the head of the first segment; cells must be free.
func (s *Sim) Spawn(id VehicleID, route []SegmentID, length int) error {
	if length < 1 {
		return fmt.Errorf("vehicle %d: length must be >= 1", id)
	}
	if len(route) == 0 {
		return fmt.Errorf("vehicle %d: empty route", id)
	}
	if _, dup := s.Vehicles[id]; dup {
		return fmt.Errorf("vehicle %d: duplicate", id)
	}
	for i := 0; i+1 < len(route); i++ {
		a, b := s.Segments[route[i]], s.Segments[route[i+1]]
		if a == nil || b == nil {
			return fmt.Errorf("vehicle %d: route references unknown segment", id)
		}
		if a.To != b.From {
			return fmt.Errorf("vehicle %d: route segments %d and %d are not connected", id, route[i], route[i+1])
		}
	}
	first := s.Segments[route[0]]
	if first == nil {
		return fmt.Errorf("vehicle %d: route references unknown segment", id)
	}
	if first.Length < length {
		return fmt.Errorf("vehicle %d: length %d exceeds first segment capacity %d", id, length, first.Length)
	}
	cells := make([]Cell, length)
	for i := 0; i < length; i++ {
		c := Cell{Seg: route[0], Idx: length - 1 - i}
		if _, taken := s.occ[c]; taken {
			return fmt.Errorf("vehicle %d: spawn cell %v occupied", id, c)
		}
		cells[i] = c
	}
	v := &Vehicle{ID: id, Route: append([]SegmentID(nil), route...), Cells: cells}
	s.Vehicles[id] = v
	for _, c := range cells {
		s.occ[c] = id
	}
	s.Spawned++
	return nil
}

// advance shifts the whole vehicle one cell forward: the tail cell is
// released and the target cell becomes the new head.
func (s *Sim) advance(v *Vehicle, target Cell) {
	delete(s.occ, v.Cells[len(v.Cells)-1])
	for i := len(v.Cells) - 1; i > 0; i-- {
		v.Cells[i] = v.Cells[i-1]
	}
	v.Cells[0] = target
	s.occ[target] = v.ID
}

func (s *Sim) sortedVehicleIDs() []VehicleID {
	ids := make([]VehicleID, 0, len(s.Vehicles))
	for id := range s.Vehicles {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func (s *Sim) isRequester(v *Vehicle) bool {
	head := v.Cells[0]
	seg := s.Segments[head.Seg]
	return head.Idx == seg.Length-1 && v.HeadRoute+1 < len(v.Route)
}

// Step advances the simulation by one tick.
//
// Phase 1 (release): vehicles not blocked at an intersection advance if
// their next cell is free, freeing tail cells; vehicles at the end of
// their final segment shed their head cell and eventually leave. Vehicles
// are processed downstream-first per segment so platoons move together.
//
// Phase 2 (grant): vehicles waiting to cross into their next segment are
// considered in order of waiting duration (longest first), ties broken by
// smaller vehicle ID. A request is granted only if the entry cell is free
// (after phase-1 releases and earlier grants) and its movement does not
// conflict, per the public conflict table, with any movement already
// granted at the same node this tick.
func (s *Sim) Step() {
	s.Tick++
	s.Grants = s.Grants[:0]

	// Phase 1: release / internal movement.
	movers := make([]*Vehicle, 0, len(s.Vehicles))
	for _, id := range s.sortedVehicleIDs() {
		movers = append(movers, s.Vehicles[id])
	}
	sort.Slice(movers, func(i, j int) bool {
		a, b := movers[i].Cells[0], movers[j].Cells[0]
		if a.Seg != b.Seg {
			return a.Seg < b.Seg
		}
		return a.Idx > b.Idx // downstream first
	})
	for _, v := range movers {
		head := v.Cells[0]
		seg := s.Segments[head.Seg]
		if head.Idx == seg.Length-1 {
			if v.HeadRoute+1 == len(v.Route) {
				// Finishing: head leaves the network; the tail keeps
				// occupying the segment until it leaves too.
				delete(s.occ, head)
				v.Cells = v.Cells[1:]
				if len(v.Cells) == 0 {
					delete(s.Vehicles, v.ID)
					s.Finished++
				}
			}
			continue // crossing requesters are handled in phase 2
		}
		target := Cell{Seg: head.Seg, Idx: head.Idx + 1}
		if _, blocked := s.occ[target]; blocked {
			continue
		}
		s.advance(v, target)
	}

	// Phase 2: grant crossings by (waiting duration desc, ID asc).
	var reqs []*Vehicle
	for _, id := range s.sortedVehicleIDs() {
		v := s.Vehicles[id]
		if s.isRequester(v) {
			reqs = append(reqs, v)
		}
	}
	sort.Slice(reqs, func(i, j int) bool {
		if reqs[i].Wait != reqs[j].Wait {
			return reqs[i].Wait > reqs[j].Wait
		}
		return reqs[i].ID < reqs[j].ID
	})
	grantedMoves := make(map[NodeID][]Movement)
	for _, v := range reqs {
		cur := v.Cells[0].Seg
		next := v.Route[v.HeadRoute+1]
		node := s.Segments[cur].To
		move := Movement{From: cur, To: next}
		blocked := false
		for _, g := range grantedMoves[node] {
			if s.Conflicts.Conflicts(node, move, g) {
				blocked = true
				break
			}
		}
		target := Cell{Seg: next, Idx: 0}
		if !blocked {
			if _, taken := s.occ[target]; taken {
				blocked = true
			}
		}
		if blocked {
			v.Wait++
			continue
		}
		s.advance(v, target)
		v.HeadRoute++
		v.Wait = 0
		grantedMoves[node] = append(grantedMoves[node], move)
		s.Grants = append(s.Grants, v.ID)
	}
}

// WaitForEdges builds the capacity wait-for graph: an edge v -> w means
// vehicle v's next cell is currently occupied by vehicle w. A cycle in
// this graph is a gridlock (deadlock) ring.
func (s *Sim) WaitForEdges() [][2]VehicleID {
	var edges [][2]VehicleID
	for _, id := range s.sortedVehicleIDs() {
		v := s.Vehicles[id]
		head := v.Cells[0]
		seg := s.Segments[head.Seg]
		var target Cell
		if head.Idx == seg.Length-1 {
			if v.HeadRoute+1 >= len(v.Route) {
				continue // finishing, not waiting
			}
			target = Cell{Seg: v.Route[v.HeadRoute+1], Idx: 0}
		} else {
			target = Cell{Seg: head.Seg, Idx: head.Idx + 1}
		}
		if w, taken := s.occ[target]; taken && w != v.ID {
			edges = append(edges, [2]VehicleID{v.ID, w})
		}
	}
	return edges
}

// FindCycle returns one cycle in the wait-for graph, or nil if acyclic.
func FindCycle(edges [][2]VehicleID) []VehicleID {
	adj := make(map[VehicleID][]VehicleID)
	for _, e := range edges {
		adj[e[0]] = append(adj[e[0]], e[1])
	}
	for k := range adj {
		sort.Slice(adj[k], func(i, j int) bool { return adj[k][i] < adj[k][j] })
	}
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[VehicleID]int)
	var stack []VehicleID
	var visit func(u VehicleID) []VehicleID
	visit = func(u VehicleID) []VehicleID {
		color[u] = gray
		stack = append(stack, u)
		for _, w := range adj[u] {
			switch color[w] {
			case gray:
				for i, x := range stack {
					if x == w {
						return append([]VehicleID(nil), stack[i:]...)
					}
				}
			case white:
				if cyc := visit(w); cyc != nil {
					return cyc
				}
			}
		}
		stack = stack[:len(stack)-1]
		color[u] = black
		return nil
	}
	nodes := make([]VehicleID, 0, len(adj))
	for u := range adj {
		nodes = append(nodes, u)
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i] < nodes[j] })
	for _, u := range nodes {
		if color[u] == white {
			if cyc := visit(u); cyc != nil {
				return cyc
			}
		}
	}
	return nil
}

// Verify checks the simulation invariants and returns nil when all hold:
//   - conservation: Spawned == active vehicles + finished vehicles
//   - no collision: no two vehicles occupy the same cell, all cells in
//     bounds, and each vehicle's cells are contiguous along its route
//   - the internal occupancy index matches the vehicle states exactly
func (s *Sim) Verify() error {
	seen := make(map[Cell]VehicleID)
	for _, id := range s.sortedVehicleIDs() {
		v := s.Vehicles[id]
		if len(v.Cells) == 0 {
			return fmt.Errorf("vehicle %d: no cells", v.ID)
		}
		for _, c := range v.Cells {
			seg := s.Segments[c.Seg]
			if seg == nil || c.Idx < 0 || c.Idx >= seg.Length {
				return fmt.Errorf("vehicle %d: cell %v out of bounds", v.ID, c)
			}
			if w, dup := seen[c]; dup {
				return fmt.Errorf("collision at cell %v: vehicles %d and %d", c, w, v.ID)
			}
			seen[c] = v.ID
		}
		for i := 0; i+1 < len(v.Cells); i++ {
			if !s.adjacentOnRoute(v, v.Cells[i], v.Cells[i+1]) {
				return fmt.Errorf("vehicle %d: cells %v and %v not contiguous on route", v.ID, v.Cells[i], v.Cells[i+1])
			}
		}
	}
	if len(seen) != len(s.occ) {
		return fmt.Errorf("occupancy index size %d, expected %d", len(s.occ), len(seen))
	}
	for c, id := range seen {
		if s.occ[c] != id {
			return fmt.Errorf("occupancy index mismatch at %v", c)
		}
	}
	if s.Spawned != len(s.Vehicles)+s.Finished {
		return fmt.Errorf("conservation violated: spawned=%d active=%d finished=%d",
			s.Spawned, len(s.Vehicles), s.Finished)
	}
	return nil
}

// adjacentOnRoute reports whether cell b immediately follows cell a for
// the given vehicle (a is one cell closer to the head).
func (s *Sim) adjacentOnRoute(v *Vehicle, a, b Cell) bool {
	if a.Seg == b.Seg {
		return a.Idx == b.Idx+1
	}
	segB := s.Segments[b.Seg]
	if segB == nil || b.Idx != segB.Length-1 || a.Idx != 0 {
		return false
	}
	for k := 0; k+1 < len(v.Route); k++ {
		if v.Route[k] == b.Seg && v.Route[k+1] == a.Seg {
			return true
		}
	}
	return false
}

// StateString is a canonical, deterministic rendering of the full state,
// used as the trajectory for snapshot/restore equivalence checks.
func (s *Sim) StateString() string {
	var b strings.Builder
	fmt.Fprintf(&b, "tick=%d active=%d finished=%d grants=%v\n", s.Tick, len(s.Vehicles), s.Finished, s.Grants)
	for _, id := range s.sortedVehicleIDs() {
		v := s.Vehicles[id]
		fmt.Fprintf(&b, "v%d hr=%d wait=%d cells=%v\n", v.ID, v.HeadRoute, v.Wait, v.Cells)
	}
	return b.String()
}
