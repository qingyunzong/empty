package trainsim

import (
	"reflect"
	"testing"
)

func rejectEvents(sim *Sim) []Event {
	var out []Event
	for _, e := range sim.Events {
		if e.Type == EventReject {
			out = append(out, e)
		}
	}
	return out
}

func TestMutualExclusionAndRecovery(t *testing.T) {
	t1 := NewTrain(1, []int{1, 2, 3, 4, 5}, 1)
	t2 := NewTrain(2, []int{2, 3, 4, 5, 6}, 1)
	sim := NewSim(t1, t2)
	sim.Run(20)

	if err := VerifyEvents(sim.Events); err != nil {
		t.Fatalf("duplicate occupancy detected: %v", err)
	}
	if t1.State != StateArrived || t2.State != StateArrived {
		t.Fatalf("expected both trains arrived, got %v and %v", t1.State, t2.State)
	}
	// t1 starts directly behind t2 and must have been rejected at least once.
	rejects := rejectEvents(sim)
	if len(rejects) == 0 {
		t.Fatal("expected at least one rejection for the trailing train")
	}
	ev := rejects[0].Evidence
	if ev == nil || ev.Holder != 2 || ev.BlockedSection != 2 {
		t.Fatalf("unexpected first rejection evidence: %+v", ev)
	}
	recovered, err := Recover(sim.Events)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	snap := sim.Snapshot()
	if !reflect.DeepEqual(recovered.Occupancy, snap.Occupancy) {
		t.Fatalf("recovered occupancy %v != snapshot %v", recovered.Occupancy, snap.Occupancy)
	}
}

func TestBrakingDistanceReservation(t *testing.T) {
	route := []int{1, 2, 3, 4, 5, 6}
	tr := NewTrain(1, route, 2)
	sim := NewSim(tr)
	sim.Run(20)

	if tr.State != StateArrived {
		t.Fatalf("train did not arrive: %v", tr.State)
	}
	// For every enter event at tick k into route[i], the same tick must
	// contain reserve events covering route[i] and route[i+1] (if any).
	reserved := map[[2]int]bool{} // (tick, section) reserved by the train
	for _, e := range sim.Events {
		if e.Type == EventReserve {
			reserved[[2]int{e.Tick, e.Section}] = true
		}
	}
	for _, e := range sim.Events {
		if e.Type != EventEnter || e.Tick == 0 {
			continue
		}
		idx := -1
		for i, sec := range route {
			if sec == e.Section {
				idx = i
			}
		}
		for j := idx; j <= idx+1 && j < len(route); j++ {
			if !reserved[[2]int{e.Tick, route[j]}] {
				t.Fatalf("enter section %d at tick %d without reservation of section %d",
					e.Section, e.Tick, route[j])
			}
		}
	}
}

func TestConflictPriorityEarlierWaitWins(t *testing.T) {
	t1 := NewTrain(1, []int{1, 3, 4}, 1)
	t2 := NewTrain(2, []int{2, 3}, 1)
	sim := NewSim(t1, t2)
	t1.WaitSince = 2
	t2.WaitSince = 5
	sim.Step()

	if t1.Section() != 3 {
		t.Fatalf("earlier-waiting train 1 should hold section 3, at %d", t1.Section())
	}
	if t2.Section() != 2 || t2.State != StateWaiting {
		t.Fatalf("train 2 should still wait at section 2, got section %d state %v", t2.Section(), t2.State)
	}
	rejects := rejectEvents(sim)
	if len(rejects) != 1 {
		t.Fatalf("expected exactly one rejection, got %d", len(rejects))
	}
	ev := rejects[0].Evidence
	if ev.TrainID != 2 || ev.Holder != 1 || ev.RequesterWaitSince != 5 {
		t.Fatalf("evidence does not record priority comparison: %+v", ev)
	}
	if ev.HolderWaitSince >= ev.RequesterWaitSince {
		t.Fatalf("holder should have waited at most as long as requester: %+v", ev)
	}
}

func TestConflictPriorityTieBreakByID(t *testing.T) {
	t1 := NewTrain(1, []int{1, 3, 4}, 1)
	t2 := NewTrain(2, []int{2, 3}, 1)
	sim := NewSim(t1, t2)
	t1.WaitSince = 4
	t2.WaitSince = 4
	sim.Step()

	if t1.Section() != 3 || t2.State != StateWaiting {
		t.Fatalf("tie should go to smaller ID: t1 section %d, t2 state %v", t1.Section(), t2.State)
	}
}

func TestFaultedTrainKeepsSection(t *testing.T) {
	t1 := NewTrain(1, []int{1, 2, 3, 4, 5}, 1)
	t1.FaultAt = 2
	t2 := NewTrain(2, []int{0, 1, 2, 3, 4, 5}, 1)
	sim := NewSim(t1, t2)
	sim.Run(15)

	if t1.State != StateFaulted {
		t.Fatalf("train 1 should be faulted, got %v", t1.State)
	}
	if sim.Occupancy[2] != 1 {
		t.Fatalf("faulted train 1 must keep occupying section 2, occupancy=%v", sim.Occupancy)
	}
	for _, e := range sim.Events {
		if e.Type == EventEnter && e.TrainID == 2 && e.Section == 2 {
			t.Fatal("train 2 entered the section held by the faulted train")
		}
	}
	rejects := rejectEvents(sim)
	if len(rejects) == 0 {
		t.Fatal("expected rejections for train 2 behind the faulted train")
	}
	last := rejects[len(rejects)-1].Evidence
	if last.Holder != 1 || last.HolderState != "Faulted" || last.BlockedSection != 2 {
		t.Fatalf("unexpected final rejection evidence: %+v", last)
	}
	if err := VerifyEvents(sim.Events); err != nil {
		t.Fatalf("duplicate occupancy detected: %v", err)
	}
	recovered, err := Recover(sim.Events)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	if recovered.Occupancy[2] != 1 {
		t.Fatalf("recovered state lost faulted train occupancy: %v", recovered.Occupancy)
	}
}

func TestSnapshotRecoveryRoundTrip(t *testing.T) {
	t1 := NewTrain(1, []int{1, 2, 3, 4, 5, 6, 7, 8}, 2)
	t2 := NewTrain(2, []int{2, 3, 4, 5, 6, 7, 8, 9}, 2)
	t3 := NewTrain(3, []int{5, 6, 7, 8, 9, 10}, 1)
	t3.FaultAt = 4
	sim := NewSim(t1, t2, t3)
	sim.Run(30)

	data, err := MarshalEvents(sim.Events)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	loaded, err := UnmarshalEvents(data)
	if err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if err := VerifyEvents(loaded); err != nil {
		t.Fatalf("duplicate occupancy after round trip: %v", err)
	}
	recovered, err := Recover(loaded)
	if err != nil {
		t.Fatalf("recover: %v", err)
	}
	snap := sim.Snapshot()
	if !reflect.DeepEqual(recovered.Occupancy, snap.Occupancy) {
		t.Fatalf("recovered %v != snapshot %v", recovered.Occupancy, snap.Occupancy)
	}
	if recovered.Tick != snap.Tick {
		t.Fatalf("recovered tick %d != snapshot tick %d", recovered.Tick, snap.Tick)
	}
}

func TestVerifyEventsDetectsDuplicateOccupancy(t *testing.T) {
	bad := []Event{
		{Tick: 0, Type: EventEnter, TrainID: 1, Section: 5},
		{Tick: 1, Type: EventEnter, TrainID: 2, Section: 5},
	}
	if err := VerifyEvents(bad); err == nil {
		t.Fatal("expected duplicate occupancy error")
	}
	if _, err := Recover(bad); err == nil {
		t.Fatal("expected Recover to reject a log with duplicate occupancy")
	}
}
