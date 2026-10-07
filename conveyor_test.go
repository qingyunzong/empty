package conveyor

import (
	"reflect"
	"testing"
)

func ids(pkgs []Package) []int {
	out := make([]int, 0, len(pkgs))
	for _, p := range pkgs {
		out = append(out, p.ID)
	}
	return out
}

// Tick order is move -> insert -> remove: a package injected into an empty
// belt appears at the insert slot on the first tick and is removed only when
// it reaches its destination port.
func TestTickOrderMoveInsertRemove(t *testing.T) {
	belt := NewBelt(0, 3, 0)
	sys := NewSystem([]*Belt{belt}, nil)
	sys.Inject(0, Package{ID: 1, DestBelt: 0, DestSlot: 2})

	if out := sys.Tick(); len(out) != 0 {
		t.Fatalf("tick 1 removed %v", out)
	}
	if belt.Slot(0) == nil || belt.Slot(0).ID != 1 {
		t.Fatalf("tick 1: package not at insert slot, belt %v", belt)
	}
	sys.Tick() // moves to slot 1
	if belt.Slot(1) == nil || belt.Slot(1).ID != 1 {
		t.Fatalf("tick 2: package not at slot 1, belt %v", belt)
	}
	out := sys.Tick() // moves to slot 2 == dest, removed
	if !reflect.DeepEqual(ids(out), []int{1}) {
		t.Fatalf("tick 3: outputs %v", ids(out))
	}
	if err := sys.VerifyConservation([]int{1}); err != nil {
		t.Fatal(err)
	}
}

// A package inserted at slot n-1 wraps around to slot 0 on the next move.
func TestWrapAround(t *testing.T) {
	belt := NewBelt(0, 3, 2)
	sys := NewSystem([]*Belt{belt}, nil)
	sys.Inject(0, Package{ID: 7, DestBelt: 0, DestSlot: 1})

	sys.Tick() // inserted at slot 2
	if belt.Slot(2) == nil {
		t.Fatalf("tick 1: want package at slot 2, belt %v", belt)
	}
	sys.Tick() // wraps to slot 0
	if belt.Slot(0) == nil || belt.Slot(0).ID != 7 {
		t.Fatalf("tick 2: want package wrapped to slot 0, belt %v", belt)
	}
	out := sys.Tick() // moves to slot 1 == dest
	if !reflect.DeepEqual(ids(out), []int{7}) {
		t.Fatalf("tick 3: outputs %v", ids(out))
	}
}

// While the insert slot is occupied, injected packages wait in a FIFO queue.
func TestInjectionQueueWhenBlocked(t *testing.T) {
	belt := NewBelt(0, 2, 0)
	sys := NewSystem([]*Belt{belt}, nil)
	for _, id := range []int{1, 2, 3} {
		sys.Inject(0, Package{ID: id, DestBelt: 0, DestSlot: 1})
	}
	if belt.QueueLen() != 3 {
		t.Fatalf("queue len %d, want 3", belt.QueueLen())
	}
	var got []int
	for tick := 0; tick < 4; tick++ {
		got = append(got, ids(sys.Tick())...)
	}
	if !reflect.DeepEqual(got, []int{1, 2, 3}) {
		t.Fatalf("outputs %v, want FIFO [1 2 3]", got)
	}
	if belt.QueueLen() != 0 {
		t.Fatalf("queue not drained: %d", belt.QueueLen())
	}
	if err := sys.VerifyConservation([]int{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
}

// A faulty slot pauses the whole belt's movement but not injection/removal;
// clearing the fault resumes movement.
func TestFaultPausesWholeBelt(t *testing.T) {
	belt := NewBelt(0, 4, 0)
	sys := NewSystem([]*Belt{belt}, nil)
	sys.Inject(0, Package{ID: 1, DestBelt: 0, DestSlot: 3})
	sys.Tick() // pkg 1 inserted at slot 0
	sys.Tick() // pkg 1 moves to slot 1

	belt.SetFault(2, true)
	sys.Inject(0, Package{ID: 2, DestBelt: 0, DestSlot: 3})
	for k := 0; k < 3; k++ {
		sys.Tick()
		if belt.Slot(1) == nil || belt.Slot(1).ID != 1 {
			t.Fatalf("paused belt moved, belt %v", belt)
		}
	}
	// Injection still works while paused: pkg 2 entered the free slot 0.
	if belt.Slot(0) == nil || belt.Slot(0).ID != 2 {
		t.Fatalf("injection blocked while paused, belt %v", belt)
	}
	belt.SetFault(2, false)
	sys.Tick() // both move one slot
	if belt.Slot(1) == nil || belt.Slot(1).ID != 2 || belt.Slot(2) == nil || belt.Slot(2).ID != 1 {
		t.Fatalf("movement did not resume correctly, belt %v", belt)
	}
	out := sys.Tick() // pkg 1 reaches slot 3
	if !reflect.DeepEqual(ids(out), []int{1}) {
		t.Fatalf("outputs %v, want [1]", ids(out))
	}
	out = sys.Tick() // pkg 2 reaches slot 3
	if !reflect.DeepEqual(ids(out), []int{2}) {
		t.Fatalf("outputs %v, want [2]", ids(out))
	}
}
