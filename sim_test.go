package trafficsim

import (
	"fmt"
	"strings"
	"testing"
)

// placeAtEnd puts a vehicle on route[idx] with its front at the segment end.
func placeAtEnd(s *Sim, id VehicleID, idx int) {
	v := s.Vehicles[id]
	v.Entered = true
	v.RouteIndex = idx
	v.Position = s.Segments[v.Route[idx]].Length
}

// TestReleaseBeforeGrantSameTick pins the tick order: a vehicle that
// finishes on its last segment frees its capacity in the release phase, so
// a waiting vehicle is granted into that capacity in the same tick.
func TestReleaseBeforeGrantSameTick(t *testing.T) {
	s := NewSim()
	a := s.AddSegment(10, 5, 1)
	b := s.AddSegment(10, 5, 1)
	ix := s.AddIntersection()
	s.Connect(ix, a, b)

	v1 := s.AddVehicle([]SegmentID{a, b}, 2, 0)
	v2 := s.AddVehicle([]SegmentID{a, b}, 2, 0)
	placeAtEnd(s, v1, 1) // front at end of b (last segment) -> arrives on release
	placeAtEnd(s, v2, 0) // waiting to enter b

	s.Tick()

	if !s.Vehicles[v1].Arrived {
		t.Fatal("v1 must arrive during the release phase")
	}
	if got := s.Vehicles[v2].RouteIndex; got != 1 {
		t.Fatalf("v2 must be granted into b in the same tick, RouteIndex = %d", got)
	}
}

// TestGrantOrderByWaitThenID pins the grant order within one tick: longest
// waiting time first, ties broken by smallest vehicle ID.
func TestGrantOrderByWaitThenID(t *testing.T) {
	build := func() (*Sim, VehicleID, VehicleID) {
		s := NewSim()
		a := s.AddSegment(10, 5, 1)
		b := s.AddSegment(10, 5, 1)
		c := s.AddSegment(10, 5, 1)
		ix := s.AddIntersection()
		s.Connect(ix, a, c)
		s.Connect(ix, b, c)
		v1 := s.AddVehicle([]SegmentID{a, c}, 2, 0)
		v2 := s.AddVehicle([]SegmentID{b, c}, 2, 0)
		placeAtEnd(s, v1, 0)
		placeAtEnd(s, v2, 0)
		return s, v1, v2
	}

	t.Run("longer wait wins", func(t *testing.T) {
		s, v1, v2 := build()
		s.Vehicles[v2].WaitTicks = 5
		s.Tick()
		if s.Vehicles[v2].RouteIndex != 1 {
			t.Fatal("v2 waited longer and must be granted first")
		}
		if s.Vehicles[v1].RouteIndex != 0 || s.Vehicles[v1].WaitTicks != 1 {
			t.Fatal("v1 must be denied (capacity 1) and accumulate wait time")
		}
	})

	t.Run("tie broken by ID", func(t *testing.T) {
		s, v1, v2 := build()
		s.Vehicles[v1].WaitTicks = 3
		s.Vehicles[v2].WaitTicks = 3
		s.Tick()
		if s.Vehicles[v1].RouteIndex != 1 {
			t.Fatal("on equal wait the smaller ID (v1) must be granted first")
		}
		if s.Vehicles[v2].RouteIndex != 0 {
			t.Fatal("v2 must be denied (capacity 1)")
		}
	})
}

// TestTailOccupancy pins that a vehicle keeps occupying its previous
// segment until its tail (front position minus vehicle length) has left it.
func TestTailOccupancy(t *testing.T) {
	s := NewSim()
	a := s.AddSegment(10, 2, 1)
	b := s.AddSegment(10, 2, 1)
	ix := s.AddIntersection()
	s.Connect(ix, a, b)

	v1 := s.AddVehicle([]SegmentID{a, b}, 4, 0)
	v2 := s.AddVehicle([]SegmentID{a, b}, 4, 0)

	s.Tick() // v1 spawns into a; v2 denied (capacity 1)
	if !s.Vehicles[v1].Entered || s.Vehicles[v2].Entered {
		t.Fatal("tick 1: v1 enters a, v2 waits")
	}

	// Advance until v1 is granted into b.
	for s.Vehicles[v1].RouteIndex == 0 {
		s.Tick()
	}
	if got := s.Occupancy(a); got != 1 {
		t.Fatalf("v1 tail still on a: occupancy(a) = %d, want 1", got)
	}
	if s.Vehicles[v2].Entered {
		t.Fatal("v2 must stay blocked while v1's tail occupies a")
	}

	s.Tick() // v1 front at 2 < 4: tail still on a
	if got := s.Occupancy(a); got != 1 {
		t.Fatalf("v1 tail still on a at position 2: occupancy(a) = %d, want 1", got)
	}
	if s.Vehicles[v2].Entered {
		t.Fatal("v2 must stay blocked while v1's tail occupies a")
	}

	s.Tick() // v1 front at 4 = vehicle length: tail has left a
	if !s.Vehicles[v2].Entered {
		t.Fatal("v2 must be granted once v1's tail has left a")
	}
	// v2 now occupies a in v1's place.
	if got := s.Occupancy(a); got != 1 {
		t.Fatalf("after v2 entered: occupancy(a) = %d, want 1", got)
	}
}

// buildCrossingSim builds a cross intersection where movements a->c and
// b->d are mutually exclusive, with 6 vehicles queued on each approach.
func buildCrossingSim() *Sim {
	s := NewSim()
	a := s.AddSegment(10, 10, 4)
	b := s.AddSegment(10, 10, 4)
	c := s.AddSegment(10, 10, 4)
	d := s.AddSegment(10, 10, 4)
	ix := s.AddIntersection()
	s.Connect(ix, a, c)
	s.Connect(ix, b, d)
	ix.Conflicts.Add(Movement{From: a, To: c}, Movement{From: b, To: d})
	for i := 0; i < 6; i++ {
		s.AddVehicle([]SegmentID{a, c}, 2, 0)
	}
	for i := 0; i < 6; i++ {
		s.AddVehicle([]SegmentID{b, d}, 2, 0)
	}
	return s
}

// TestVehicleConservation runs the crossing scenario and checks that
// vehicles are never created or destroyed: every vehicle is exactly one of
// pending/active/arrived at every tick, and eventually all arrive.
func TestVehicleConservation(t *testing.T) {
	s := buildCrossingSim()
	total := len(s.Vehicles)
	for tick := 0; tick < 30; tick++ {
		s.Tick()
		pending, active, arrived := 0, 0, 0
		seen := make(map[VehicleID]bool)
		for _, v := range s.Vehicles {
			if seen[v.ID] {
				t.Fatalf("tick %d: duplicate vehicle ID %d", s.TickCount, v.ID)
			}
			seen[v.ID] = true
			switch {
			case v.Arrived:
				arrived++
			case v.Entered:
				active++
			default:
				pending++
			}
		}
		if pending+active+arrived != total {
			t.Fatalf("tick %d: conservation violated: %d pending + %d active + %d arrived != %d",
				s.TickCount, pending, active, arrived, total)
		}
	}
	for _, v := range s.Vehicles {
		if !v.Arrived {
			t.Fatalf("vehicle %d never arrived; possible loss or starvation", v.ID)
		}
	}
}

// TestNoCollision checks the safety invariants at every tick: segment
// capacities are never exceeded, and no two conflicting movements are
// granted at the same intersection in the same tick. It also checks the
// conflict table actually blocked a request (otherwise the test is vacuous).
func TestNoCollision(t *testing.T) {
	s := buildCrossingSim()
	conflictBlocked := false
	for tick := 0; tick < 30; tick++ {
		s.Tick()
		for _, seg := range s.Segments {
			if occ := s.Occupancy(seg.ID); occ > seg.Capacity {
				t.Fatalf("tick %d: segment %d occupancy %d exceeds capacity %d",
					s.TickCount, seg.ID, occ, seg.Capacity)
			}
		}
		byIX := make(map[int][]Crossing)
		for _, cr := range s.CrossingLog {
			if cr.Tick == s.TickCount {
				byIX[cr.Intersection] = append(byIX[cr.Intersection], cr)
			}
		}
		for ixID, crossings := range byIX {
			var table *ConflictTable
			if ixID >= 0 {
				table = s.Intersections[ixID].Conflicts
			}
			for i := 0; i < len(crossings); i++ {
				for j := i + 1; j < len(crossings); j++ {
					if table.Conflicts(crossings[i].Movement, crossings[j].Movement) {
						t.Fatalf("tick %d: collision at intersection %d: vehicles %d and %d granted conflicting movements %v and %v",
							s.TickCount, ixID, crossings[i].Vehicle, crossings[j].Vehicle,
							crossings[i].Movement, crossings[j].Movement)
					}
				}
			}
		}
		for _, v := range s.Vehicles {
			if v.Entered && !v.Arrived && v.WaitTicks > 0 {
				target, blocked := s.blockedOn(v)
				if blocked && s.Occupancy(target) < s.Segments[target].Capacity {
					conflictBlocked = true // denied despite free capacity: conflict table at work
				}
			}
		}
	}
	if !conflictBlocked {
		t.Fatal("no request was ever blocked by the conflict table; test is vacuous")
	}
}

// trajectory records every vehicle's state per tick as a string.
func trajectory(s *Sim, ticks int) string {
	var sb strings.Builder
	for i := 0; i < ticks; i++ {
		s.Tick()
		for _, v := range s.Vehicles {
			fmt.Fprintf(&sb, "%d:%d:%t:%t:%d:%g:%d|",
				s.TickCount, v.ID, v.Entered, v.Arrived, v.RouteIndex, v.Position, v.WaitTicks)
		}
		sb.WriteByte('\n')
	}
	return sb.String()
}

// TestSnapshotConsistency checks that continuing from a snapshot produces
// exactly the same trajectory as continuing the original simulation.
func TestSnapshotConsistency(t *testing.T) {
	s := buildCrossingSim()
	for i := 0; i < 5; i++ {
		s.Tick()
	}
	snap := s.Snapshot()

	want := trajectory(s, 12)
	got := trajectory(snap, 12)
	if want != got {
		t.Fatalf("snapshot trajectory diverged:\n--- original ---\n%s\n--- snapshot ---\n%s", want, got)
	}

	// A snapshot of the restored copy must also be reusable.
	snap2 := snap.Snapshot()
	if got2, want2 := trajectory(snap, 4), trajectory(snap2, 4); got2 != want2 {
		t.Fatal("second-generation snapshot trajectory diverged")
	}
}

// TestDeadlockCycleEvidence builds a 4-segment ring that gridlocks and
// checks the wait-for cycle returned as deadlock evidence.
func TestDeadlockCycleEvidence(t *testing.T) {
	s := NewSim()
	ring := make([]SegmentID, 4)
	for i := range ring {
		ring[i] = s.AddSegment(10, 10, 1)
	}
	ix := s.AddIntersection()
	for i := range ring {
		s.Connect(ix, ring[i], ring[(i+1)%4])
		s.AddVehicle([]SegmentID{ring[i], ring[(i+1)%4]}, 2, 0)
	}

	s.Tick() // all four spawn into their first segment
	if c := s.FindDeadlockCycle(); c != nil {
		t.Fatalf("no deadlock expected yet, got cycle %v", c)
	}

	s.Tick() // all reach segment ends and block on the next, full segment
	cycle := s.FindDeadlockCycle()
	if len(cycle) != 4 {
		t.Fatalf("deadlock cycle = %v, want 4 vehicles", cycle)
	}

	// The evidence must be a real cycle of the wait-for graph.
	g := s.WaitForGraph()
	for i, v := range cycle {
		next := cycle[(i+1)%len(cycle)]
		found := false
		for _, w := range g[v] {
			if w == next {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("cycle edge %d -> %d missing from wait-for graph %v", v, next, g)
		}
	}

	// The deadlock is stable: nothing moves anymore.
	before := trajectory(s, 0)
	_ = before
	pos := make(map[VehicleID]float64)
	for _, v := range s.Vehicles {
		pos[v.ID] = v.Position
	}
	for i := 0; i < 5; i++ {
		s.Tick()
	}
	for _, v := range s.Vehicles {
		if v.Position != pos[v.ID] || v.Arrived {
			t.Fatalf("vehicle %d moved despite gridlock", v.ID)
		}
	}
	if c := s.FindDeadlockCycle(); len(c) != 4 {
		t.Fatalf("gridlock must persist, got cycle %v", c)
	}
}
