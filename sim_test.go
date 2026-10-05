package trafficsim

import (
	"strings"
	"testing"
)

// buildCrossroads returns a 4-arm intersection at node 10:
// approaches 1(W),2(S),6(E),7(N) and exits 3(E),4(N),8(W),9(S).
func buildCrossroads(t *testing.T) *Sim {
	t.Helper()
	s := NewSim()
	segs := []struct {
		id       SegmentID
		from, to NodeID
		length   int
	}{
		{1, 1, 10, 6}, {2, 2, 10, 6}, {6, 3, 10, 6}, {7, 4, 10, 6},
		{3, 10, 5, 8}, {4, 10, 6, 8}, {8, 10, 7, 8}, {9, 10, 8, 8},
	}
	for _, sg := range segs {
		if err := s.AddSegment(sg.id, sg.from, sg.to, sg.length); err != nil {
			t.Fatal(err)
		}
	}
	// Opposing straight movements are compatible; everything else
	// (turns, crossing paths) keeps the default mutual exclusion.
	s.Conflicts.Allow(10, Movement{1, 3}, Movement{6, 8})
	s.Conflicts.Allow(10, Movement{2, 4}, Movement{7, 9})
	return s
}

func mustSpawn(t *testing.T, s *Sim, id VehicleID, route []SegmentID, length int) {
	t.Helper()
	if err := s.Spawn(id, route, length); err != nil {
		t.Fatalf("spawn vehicle %d: %v", id, err)
	}
}

// TestConservationAndNoCollision runs a busy crossroads and checks every
// tick that vehicles are conserved, no two vehicles share a cell, cells
// stay contiguous along routes, and the occupancy index is exact.
func TestConservationAndNoCollision(t *testing.T) {
	s := buildCrossroads(t)
	// Wave 1: one straight vehicle per approach.
	mustSpawn(t, s, 1, []SegmentID{1, 3}, 2)
	mustSpawn(t, s, 2, []SegmentID{6, 8}, 3)
	mustSpawn(t, s, 3, []SegmentID{2, 4}, 1)
	mustSpawn(t, s, 4, []SegmentID{7, 9}, 2)
	if err := s.Verify(); err != nil {
		t.Fatalf("tick %d: %v", s.Tick, err)
	}
	// Let wave 1 clear the spawn cells, then add turning vehicles.
	for i := 0; i < 4; i++ {
		s.Step()
	}
	mustSpawn(t, s, 5, []SegmentID{1, 4}, 4)
	mustSpawn(t, s, 6, []SegmentID{2, 3}, 2)
	mustSpawn(t, s, 7, []SegmentID{6, 9}, 3)
	mustSpawn(t, s, 8, []SegmentID{7, 8}, 1)
	for i := 0; i < 196; i++ {
		s.Step()
		if err := s.Verify(); err != nil {
			t.Fatalf("tick %d: %v", s.Tick, err)
		}
	}
	if s.Spawned != 8 {
		t.Fatalf("spawned = %d, want 8", s.Spawned)
	}
	if s.Finished != 8 || len(s.Vehicles) != 0 {
		t.Fatalf("after 200 ticks: finished=%d active=%d, want all 8 finished",
			s.Finished, len(s.Vehicles))
	}
	t.Logf("conservation: spawned=%d finished=%d active=%d over 200 ticks, Verify ok every tick",
		s.Spawned, s.Finished, len(s.Vehicles))
}

// TestGrantOrderWaitThenID checks that among conflicting requests in one
// tick the longest-waiting vehicle is granted first, and equal waits are
// broken by smaller vehicle ID.
func TestGrantOrderWaitThenID(t *testing.T) {
	newSim := func(t *testing.T) *Sim {
		s := NewSim()
		for _, sg := range []struct {
			id       SegmentID
			from, to NodeID
			length   int
		}{{11, 20, 21, 1}, {12, 22, 21, 1}, {13, 21, 23, 4}, {14, 21, 24, 4}} {
			if err := s.AddSegment(sg.id, sg.from, sg.to, sg.length); err != nil {
				t.Fatal(err)
			}
		}
		mustSpawn(t, s, 1, []SegmentID{11, 13}, 1)
		mustSpawn(t, s, 2, []SegmentID{12, 14}, 1)
		return s
	}

	// Longer wait wins even with the larger ID.
	s := newSim(t)
	s.Vehicles[1].Wait = 3
	s.Vehicles[2].Wait = 5
	s.Step()
	if len(s.Grants) != 1 || s.Grants[0] != 2 {
		t.Fatalf("grants = %v, want [2] (longest wait)", s.Grants)
	}
	if s.Vehicles[2].Wait != 0 {
		t.Fatalf("granted vehicle wait = %d, want 0", s.Vehicles[2].Wait)
	}
	if s.Vehicles[1].Wait != 4 {
		t.Fatalf("blocked vehicle wait = %d, want 4", s.Vehicles[1].Wait)
	}

	// Equal wait: smaller ID wins.
	s = newSim(t)
	s.Step()
	if len(s.Grants) != 1 || s.Grants[0] != 1 {
		t.Fatalf("grants = %v, want [1] (ID tiebreak)", s.Grants)
	}
	if s.Vehicles[2].Wait != 1 {
		t.Fatalf("blocked vehicle wait = %d, want 1", s.Vehicles[2].Wait)
	}
	// The loser accumulated wait, so it wins the next tick.
	s.Step()
	if len(s.Grants) != 1 || s.Grants[0] != 2 {
		t.Fatalf("second-tick grants = %v, want [2] (accumulated wait)", s.Grants)
	}
}

// TestConflictTableIsPublicAndEnforced shows the conflict table is part of
// the public API and that Allow permits simultaneous compatible grants
// while the default is mutual exclusion.
func TestConflictTableIsPublicAndEnforced(t *testing.T) {
	// Default: the two straight movements conflict, one grant per tick.
	s := buildCrossroads(t)
	if !s.Conflicts.Conflicts(10, Movement{1, 3}, Movement{2, 4}) {
		t.Fatal("default should be mutual exclusion")
	}
	mustSpawn(t, s, 1, []SegmentID{1, 3}, 1)
	mustSpawn(t, s, 2, []SegmentID{2, 4}, 1)
	maxGrants := 0
	for i := 0; i < 12; i++ {
		s.Step()
		if len(s.Grants) > maxGrants {
			maxGrants = len(s.Grants)
		}
	}
	if maxGrants != 1 {
		t.Fatalf("conflicting movements: max grants per tick = %d, want 1", maxGrants)
	}

	// Allow opposing straights: both cross in the same tick.
	s = buildCrossroads(t)
	mustSpawn(t, s, 1, []SegmentID{1, 3}, 1)
	mustSpawn(t, s, 2, []SegmentID{6, 8}, 1)
	grantsSeen := 0
	for i := 0; i < 12; i++ {
		s.Step()
		if len(s.Grants) > grantsSeen {
			grantsSeen = len(s.Grants)
		}
	}
	if grantsSeen != 2 {
		t.Fatalf("allowed straight pair: max grants per tick = %d, want 2", grantsSeen)
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}
}

// TestTailOccupiesUntilItLeaves verifies a vehicle keeps occupying
// capacity on the old segment until its tail cell leaves it.
func TestTailOccupiesUntilItLeaves(t *testing.T) {
	s := NewSim()
	if err := s.AddSegment(1, 1, 2, 5); err != nil {
		t.Fatal(err)
	}
	if err := s.AddSegment(2, 2, 3, 5); err != nil {
		t.Fatal(err)
	}
	mustSpawn(t, s, 1, []SegmentID{1, 2}, 3)

	crossed := false
	for i := 0; i < 20; i++ {
		s.Step()
		v := s.Vehicles[1]
		if v == nil {
			break
		}
		head := v.Cells[0]
		if head.Seg == 2 {
			crossed = true
			tail := v.Cells[len(v.Cells)-1]
			if tail.Seg != 1 {
				t.Fatalf("tick %d: head on seg 2 but tail already left seg 1 (tail=%v)", s.Tick, tail)
			}
			// The tail cell must still be occupied capacity on segment 1.
			if got := s.occ[tail]; got != 1 {
				t.Fatalf("tick %d: tail cell %v not occupied by vehicle 1", s.Tick, tail)
			}
			// Entry cell of segment 2 is taken by the head.
			if got := s.occ[Cell{2, 0}]; got != 1 {
				t.Fatalf("tick %d: entry cell of seg 2 not held by vehicle 1", s.Tick)
			}
			if err := s.Verify(); err != nil {
				t.Fatal(err)
			}
			return
		}
	}
	if !crossed {
		t.Fatal("vehicle never crossed into segment 2")
	}
}

// TestSnapshotRestoreIdenticalTrajectory runs 30 ticks, snapshots,
// continues 20 ticks; then restores and re-runs, and also compares
// against a fresh uninterrupted 50-tick run. All trajectories must match.
func TestSnapshotRestoreIdenticalTrajectory(t *testing.T) {
	build := func(t *testing.T) *Sim {
		s := buildCrossroads(t)
		mustSpawn(t, s, 1, []SegmentID{1, 3}, 2)
		mustSpawn(t, s, 2, []SegmentID{6, 8}, 3)
		mustSpawn(t, s, 3, []SegmentID{2, 4}, 1)
		mustSpawn(t, s, 4, []SegmentID{7, 9}, 2)
		for i := 0; i < 4; i++ { // clear spawn cells before wave 2
			s.Step()
		}
		mustSpawn(t, s, 5, []SegmentID{1, 4}, 4)
		mustSpawn(t, s, 6, []SegmentID{2, 3}, 2)
		return s
	}
	run := func(s *Sim, n int) []string {
		out := make([]string, 0, n)
		for i := 0; i < n; i++ {
			s.Step()
			out = append(out, s.StateString())
		}
		return out
	}

	reference := run(build(t), 50)

	s := build(t)
	first := run(s, 30)
	snap := s.Snapshot()
	second := run(s, 20)
	interrupted := append(first, second...)

	restored, err := Restore(snap)
	if err != nil {
		t.Fatal(err)
	}
	if got := restored.StateString(); got != first[len(first)-1] {
		t.Fatalf("restored state differs from snapshot point:\nrestored:\n%s\noriginal:\n%s", got, first[len(first)-1])
	}
	continued := append(first, run(restored, 20)...)

	for i := range reference {
		if interrupted[i] != reference[i] {
			t.Fatalf("tick %d: interrupted run diverges from reference:\n%s\nvs\n%s", i+1, interrupted[i], reference[i])
		}
		if continued[i] != reference[i] {
			t.Fatalf("tick %d: snapshot-restored run diverges from reference:\n%s\nvs\n%s", i+1, continued[i], reference[i])
		}
	}
	t.Logf("snapshot at tick 30: restored run matches uninterrupted 50-tick trajectory exactly")
}

// TestNoDeadlockCycleFreeFlow runs a ring with spare capacity and proves
// via the wait-for graph that no deadlock cycle ever appears.
func TestNoDeadlockCycleFreeFlow(t *testing.T) {
	s := NewSim()
	for i := 1; i <= 4; i++ {
		from := NodeID(i)
		to := NodeID(i%4 + 1)
		if err := s.AddSegment(SegmentID(i), from, to, 5); err != nil {
			t.Fatal(err)
		}
	}
	// 12 of 20 cells occupied: vehicles genuinely queue behind each
	// other, but spare capacity rules out gridlock.
	ring := []SegmentID{1, 2, 3, 4, 1, 2, 3, 4, 1, 2}
	mustSpawn(t, s, 1, ring, 3)
	mustSpawn(t, s, 2, ring[1:], 2)
	mustSpawn(t, s, 3, ring[2:], 3)
	mustSpawn(t, s, 4, ring[3:], 2)
	if err := s.Spawn(5, ring, 2); err == nil {
		t.Fatal("expected spawn collision error")
	}
	s.Step()
	s.Step()
	mustSpawn(t, s, 5, ring, 2) // now the cells are free

	totalEdges := 0
	for i := 0; i < 200; i++ {
		s.Step()
		if err := s.Verify(); err != nil {
			t.Fatalf("tick %d: %v", s.Tick, err)
		}
		edges := s.WaitForEdges()
		totalEdges += len(edges)
		if cyc := FindCycle(edges); cyc != nil {
			t.Fatalf("tick %d: deadlock cycle detected: %v\nstate:\n%s", s.Tick, cyc, s.StateString())
		}
	}
	t.Logf("deadlock evidence: 200 ticks, wait-for graph acyclic every tick (%d capacity-wait edges inspected)",
		totalEdges)
}

// TestDeadlockCycleDetected builds a genuine gridlock ring (every segment
// full, every vehicle waiting on the next) and proves the cycle detector
// reports the ring — evidence the acyclicity checks above are not vacuous.
func TestDeadlockCycleDetected(t *testing.T) {
	s := NewSim()
	for i := 1; i <= 4; i++ {
		if err := s.AddSegment(SegmentID(i), NodeID(i), NodeID(i%4+1), 2); err != nil {
			t.Fatal(err)
		}
	}
	ring := []SegmentID{1, 2, 3, 4}
	for i := 0; i < 4; i++ {
		rotated := append(append([]SegmentID(nil), ring[i:]...), ring[:i]...)
		route := append(rotated, rotated[0])
		mustSpawn(t, s, VehicleID(i+1), route, 2)
	}
	for i := 0; i < 3; i++ {
		s.Step()
	}
	edges := s.WaitForEdges()
	cyc := FindCycle(edges)
	if cyc == nil {
		t.Fatalf("gridlock ring not detected; edges=%v state:\n%s", edges, s.StateString())
	}
	if len(cyc) != 4 {
		t.Fatalf("cycle = %v, want a 4-vehicle ring", cyc)
	}
	t.Logf("gridlock evidence: detector reports cycle %v in a fully locked ring", cyc)

	// Synthetic sanity checks of the detector itself.
	if c := FindCycle([][2]VehicleID{{1, 2}, {2, 3}, {3, 1}}); c == nil {
		t.Fatal("synthetic 3-cycle not detected")
	}
	if c := FindCycle([][2]VehicleID{{1, 2}, {2, 3}, {4, 3}}); c != nil {
		t.Fatalf("false positive on acyclic graph: %v", c)
	}
}

// TestStateStringIsDeterministic guards the trajectory format used for
// equivalence checks against map-order flakiness.
func TestStateStringIsDeterministic(t *testing.T) {
	var first string
	for i := 0; i < 20; i++ {
		s := buildCrossroads(t)
		mustSpawn(t, s, 1, []SegmentID{1, 3}, 2)
		mustSpawn(t, s, 2, []SegmentID{6, 8}, 3)
		mustSpawn(t, s, 3, []SegmentID{2, 4}, 1)
		for j := 0; j < 15; j++ {
			s.Step()
		}
		got := s.StateString()
		if i == 0 {
			first = got
			if !strings.Contains(got, "tick=15") {
				t.Fatalf("unexpected state string: %q", got)
			}
		} else if got != first {
			t.Fatalf("run %d diverged:\n%s\nvs\n%s", i, got, first)
		}
	}
}
