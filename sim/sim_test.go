package sim

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// runSteps advances the simulation n ticks, verifying invariants after
// every tick.
func runSteps(t *testing.T, s *Sim, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		s.Step()
		if err := s.Verify(); err != nil {
			t.Fatalf("tick %d: invariant violated: %v", s.Tick, err)
		}
	}
}

func mustAddTrain(t *testing.T, s *Sim, id string, pos, brake int) {
	t.Helper()
	if err := s.AddTrain(id, pos, brake); err != nil {
		t.Fatalf("AddTrain(%s): %v", id, err)
	}
}

func TestMutualExclusionAndBrakingReservation(t *testing.T) {
	s := New(10)
	mustAddTrain(t, s, "T1", 0, 2)
	mustAddTrain(t, s, "T2", 2, 2)

	runSteps(t, s, 1)
	// T1 cannot enter section 1 because section 2 (inside its braking
	// window) is occupied by T2.
	if got := s.Train("T1").Pos; got != 0 {
		t.Fatalf("T1 moved to %d, want 0 (blocked by T2)", got)
	}
	if got := s.Train("T2").Pos; got != 3 {
		t.Fatalf("T2 at %d, want 3", got)
	}
	rejects := s.Rejections()
	if len(rejects) != 1 {
		t.Fatalf("got %d rejections, want 1", len(rejects))
	}
	r := rejects[0]
	if r.Train != "T1" || len(r.Blockers) != 1 || r.Blockers[0].Section != 2 || r.Blockers[0].Occupant != "T2" {
		t.Fatalf("unexpected rejection evidence: %+v", r)
	}
	if !s.Train("T1").Waiting || s.Train("T1").WaitSince != 1 {
		t.Fatalf("T1 should be waiting since tick 1: %+v", s.Train("T1"))
	}

	// Once T2 clears the window, T1 follows; mutual exclusion always holds.
	runSteps(t, s, 2)
	if got := s.Train("T1").Pos; got != 2 {
		t.Fatalf("T1 at %d, want 2", got)
	}
}

func TestReservationConflictEvidenceNamesReserver(t *testing.T) {
	s := New(10)
	mustAddTrain(t, s, "T1", 0, 5) // braking window covers T2 and its reservations
	mustAddTrain(t, s, "T2", 3, 2)

	// Tick 1: T1's window [1..4] contains section 3 occupied by T2, so T1
	// waits. T2 moves and reserves ahead.
	runSteps(t, s, 1)
	// Tick 2: T1's window still overlaps T2's reservations/occupancy.
	runSteps(t, s, 1)

	var sawReservedBy bool
	for _, e := range s.Rejections() {
		if e.Train != "T1" {
			continue
		}
		for _, b := range e.Blockers {
			if b.ReservedBy == "T2" {
				sawReservedBy = true
			}
		}
	}
	if !sawReservedBy {
		t.Fatalf("expected rejection evidence naming T2 as reservation holder, got %+v", s.Rejections())
	}
}

func TestWaitPriorityEarliestThenID(t *testing.T) {
	s := New(8)
	mustAddTrain(t, s, "TA", 2, 3)
	mustAddTrain(t, s, "TB", 3, 2)
	mustAddTrain(t, s, "TF", 5, 1)
	s.ScheduleFault(1, "TF")

	runSteps(t, s, 1) // both TA and TB start waiting at tick 1
	if !s.Train("TA").Waiting || !s.Train("TB").Waiting {
		t.Fatalf("both trains should be waiting: TA=%+v TB=%+v", s.Train("TA"), s.Train("TB"))
	}

	// Same wait start -> ID order: TA's rejection is logged before TB's.
	runSteps(t, s, 1)
	order := rejectOrder(s, 2)
	if !reflect.DeepEqual(order, []string{"TA", "TB"}) {
		t.Fatalf("tick 2 rejection order %v, want [TA TB]", order)
	}

	// Give TB an earlier wait start -> it is processed first despite ID.
	s.Train("TB").WaitSince = 0
	runSteps(t, s, 1)
	order = rejectOrder(s, 3)
	if !reflect.DeepEqual(order, []string{"TB", "TA"}) {
		t.Fatalf("tick 3 rejection order %v, want [TB TA]", order)
	}
}

func rejectOrder(s *Sim, tick int) []string {
	var order []string
	for _, e := range s.Events {
		if e.Type == EventReject && e.Tick == tick {
			order = append(order, e.Train)
		}
	}
	return order
}

func TestFaultyTrainHoldsSectionForever(t *testing.T) {
	s := New(10)
	mustAddTrain(t, s, "T1", 0, 2)
	mustAddTrain(t, s, "T2", 2, 2)
	s.ScheduleFault(3, "T2")

	runSteps(t, s, 3)

	t2 := s.Train("T2")
	if !t2.Faulty {
		t.Fatal("T2 should be faulty")
	}
	faultPos := t2.Pos
	// The faulty train never moves and never releases its section.
	for i := 0; i < 9; i++ {
		runSteps(t, s, 1)
		if t2.Pos != faultPos {
			t.Fatalf("faulty T2 moved to section %d", t2.Pos)
		}
		if s.Occupant[faultPos] != "T2" {
			t.Fatalf("faulty T2 released section %d", faultPos)
		}
	}
	// T1 is stuck behind the faulty train and every rejection names T2.
	t1 := s.Train("T1")
	if !t1.Waiting {
		t.Fatal("T1 should be waiting behind faulty T2")
	}
	var named int
	for _, e := range s.Rejections() {
		if e.Train != "T1" {
			continue
		}
		for _, b := range e.Blockers {
			if b.Occupant == "T2" && b.Section == t2.Pos {
				named++
			}
		}
	}
	if named == 0 {
		t.Fatal("no rejection evidence names the faulty train as occupant")
	}
	// No move event ever involves the faulty train after its fault tick.
	for _, e := range s.Events {
		if e.Type == EventMove && e.Train == "T2" && e.Tick > 3 {
			t.Fatalf("faulty train moved at tick %d", e.Tick)
		}
	}
}

func TestArrivalReleasesEverything(t *testing.T) {
	s := New(4)
	mustAddTrain(t, s, "T1", 2, 2)
	runSteps(t, s, 2)

	tr := s.Train("T1")
	if !tr.Arrived {
		t.Fatal("T1 should have arrived")
	}
	for i, occ := range s.Occupant {
		if occ != "" {
			t.Fatalf("section %d still occupied by %s after arrival", i, occ)
		}
	}
	for i, r := range s.ReservedBy {
		if r != "" {
			t.Fatalf("section %d still reserved by %s after arrival", i, r)
		}
	}
}

func TestSnapshotRecoverMatchesOriginal(t *testing.T) {
	s := New(10)
	mustAddTrain(t, s, "T1", 0, 2)
	mustAddTrain(t, s, "T2", 2, 2)
	mustAddTrain(t, s, "T3", 5, 2)
	s.ScheduleFault(4, "T2")

	const snapTick = 7
	var snap *Snapshot
	for i := 0; i < 14; i++ {
		s.Step()
		if err := s.Verify(); err != nil {
			t.Fatalf("tick %d: %v", s.Tick, err)
		}
		if s.Tick == snapTick {
			snap = s.Snapshot()
		}
	}

	// Round-trip the snapshot through JSON to prove it is serialisable.
	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	var restored Snapshot
	if err := json.Unmarshal(data, &restored); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}

	// Recover replays every event after the snapshot tick and verifies
	// the no-duplicate-occupancy invariant after each one.
	rec, err := Recover(&restored, s.Events)
	if err != nil {
		t.Fatalf("Recover: %v", err)
	}
	if !reflect.DeepEqual(rec.State(), s.State()) {
		t.Fatalf("recovered state diverges:\n got %+v\nwant %+v", rec.State(), s.State())
	}
}

func TestRecoverDetectsDuplicateOccupancy(t *testing.T) {
	s := New(6)
	mustAddTrain(t, s, "T1", 0, 1)
	mustAddTrain(t, s, "T2", 2, 1)
	runSteps(t, s, 2)
	snap := s.Snapshot()

	// Corrupt the snapshot: two trains on the same section.
	snap.Trains[1].Pos = snap.Trains[0].Pos
	if _, err := Recover(snap, s.Events); err == nil ||
		!strings.Contains(err.Error(), "duplicate occupancy") {
		t.Fatalf("expected duplicate occupancy error, got %v", err)
	}
}

func TestVerifyDetectsDuplicateReservation(t *testing.T) {
	s := New(6)
	mustAddTrain(t, s, "T1", 0, 2)
	mustAddTrain(t, s, "T2", 3, 2)
	runSteps(t, s, 1)

	// Corrupt state: hand T2 a reservation T1 already holds.
	sec := s.Train("T1").needForTest(s)
	s.Train("T2").Reserved[sec] = true
	if err := s.Verify(); err == nil {
		t.Fatal("Verify should detect duplicate reservation")
	}
}

// needForTest returns a section currently reserved by t (test helper).
func (t *Train) needForTest(s *Sim) int {
	for sec := range t.Reserved {
		return sec
	}
	return -1
}

func TestAddTrainValidation(t *testing.T) {
	s := New(5)
	if err := s.AddTrain("T1", 0, 1); err != nil {
		t.Fatalf("AddTrain: %v", err)
	}
	if err := s.AddTrain("T1", 1, 1); err == nil {
		t.Fatal("duplicate id accepted")
	}
	if err := s.AddTrain("T2", 0, 1); err == nil {
		t.Fatal("double occupancy accepted at add time")
	}
	if err := s.AddTrain("T3", 9, 1); err == nil {
		t.Fatal("out-of-range position accepted")
	}
	if err := s.AddTrain("T4", 1, 0); err == nil {
		t.Fatal("zero braking distance accepted")
	}
}

func TestTrajectoryRecorded(t *testing.T) {
	s := New(8)
	mustAddTrain(t, s, "T1", 0, 1)
	runSteps(t, s, 3)

	traj := s.Train("T1").Traj
	want := []TrackPoint{{0, 0}, {1, 1}, {2, 2}, {3, 3}}
	if !reflect.DeepEqual(traj, want) {
		t.Fatalf("trajectory %v, want %v", traj, want)
	}
}
