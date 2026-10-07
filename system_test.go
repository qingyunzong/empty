package conveyor

import (
	"math/rand"
	"reflect"
	"testing"
)

// A package whose destination is on another belt crosses through the
// interface: source slot -> interface buffer -> target slot.
func TestTransferAcrossBelts(t *testing.T) {
	b0 := NewBelt(0, 3, 0)
	b1 := NewBelt(1, 3, 0)
	iface := &Interface{ID: 1, FromBelt: 0, FromSlot: 1, ToBelt: 1, ToSlot: 0, Capacity: 2}
	sys := NewSystem([]*Belt{b0, b1}, []*Interface{iface})
	sys.Inject(0, Package{ID: 1, DestBelt: 1, DestSlot: 2})

	sys.Tick() // inserted at b0 slot 0
	sys.Tick() // moves to b0 slot 1, then fills interface buffer
	if iface.BufferLen() != 1 {
		t.Fatalf("buffer len %d, want 1", iface.BufferLen())
	}
	if b0.Slot(1) != nil {
		t.Fatalf("package left behind at source slot")
	}
	sys.Tick() // drain: buffer head -> b1 slot 0
	if b1.Slot(0) == nil || b1.Slot(0).ID != 1 {
		t.Fatalf("package not transferred to b1 slot 0")
	}
	sys.Tick() // b1 slot 1
	out := sys.Tick()
	if !reflect.DeepEqual(ids(out), []int{1}) {
		t.Fatalf("outputs %v, want [1]", ids(out))
	}
	if err := sys.VerifyConservation([]int{1}); err != nil {
		t.Fatal(err)
	}
}

// While the target slot is occupied no transfer happens; the pending
// package waits in the interface buffer.
func TestTransferRequiresEmptyTarget(t *testing.T) {
	b0 := NewBelt(0, 2, 0)
	b1 := NewBelt(1, 3, 0)
	iface := &Interface{ID: 1, FromBelt: 0, FromSlot: 0, ToBelt: 1, ToSlot: 0, Capacity: 1}
	sys := NewSystem([]*Belt{b0, b1}, []*Interface{iface})
	b0.SetFault(1, true) // b0 paused: pkg stays at source slot 0
	b1.SetFault(2, true) // b1 paused: blocker stays at slot 0

	sys.Inject(0, Package{ID: 1, DestBelt: 1, DestSlot: 2})
	sys.Inject(1, Package{ID: 3, DestBelt: 1, DestSlot: 2})
	sys.Tick() // pkg1 -> b0 slot0, pkg3 -> b1 slot0
	sys.Tick() // fill: pkg1 -> buffer (now full)
	if iface.BufferLen() != 1 {
		t.Fatalf("buffer len %d, want 1", iface.BufferLen())
	}
	sys.Tick() // drain blocked: b1 slot0 occupied by pkg3
	if iface.BufferLen() != 1 {
		t.Fatalf("transfer happened despite occupied target")
	}
	if b1.Slot(0) == nil || b1.Slot(0).ID != 3 {
		t.Fatalf("blocker disturbed at b1 slot 0")
	}
	b1.SetFault(2, false)
	out := sys.Tick() // pkg3 moves to slot1; drain: pkg1 -> b1 slot0
	if len(out) != 0 {
		t.Fatalf("unexpected outputs %v", ids(out))
	}
	if b1.Slot(0) == nil || b1.Slot(0).ID != 1 {
		t.Fatalf("pkg1 not transferred after target freed")
	}
	sys.Tick() // pkg3 -> slot2 removed; pkg1 -> slot1
	sys.Tick() // pkg1 -> slot2 removed
	got := ids(sys.Outputs())
	if !reflect.DeepEqual(got, []int{3, 1}) {
		t.Fatalf("outputs %v, want [3 1]", got)
	}
}

// Two interfaces feeding the same target slot may not both transfer in one
// tick; the lower package ID wins and the loser waits.
func TestTransferTieBreakByPackageID(t *testing.T) {
	b0 := NewBelt(0, 2, 0)
	b1 := NewBelt(1, 2, 0)
	b2 := NewBelt(2, 3, 0)
	i0 := &Interface{ID: 1, FromBelt: 0, FromSlot: 0, ToBelt: 2, ToSlot: 0, Capacity: 1}
	i1 := &Interface{ID: 2, FromBelt: 1, FromSlot: 0, ToBelt: 2, ToSlot: 0, Capacity: 1}
	sys := NewSystem([]*Belt{b0, b1, b2}, []*Interface{i0, i1})
	b0.SetFault(1, true) // keep packages parked at the source slots
	b1.SetFault(1, true)

	sys.Inject(0, Package{ID: 10, DestBelt: 2, DestSlot: 2})
	sys.Inject(1, Package{ID: 5, DestBelt: 2, DestSlot: 2})
	sys.Tick() // pkg10 -> b0 slot0, pkg5 -> b1 slot0
	sys.Tick() // fill: both buffers loaded
	if i0.BufferLen() != 1 || i1.BufferLen() != 1 {
		t.Fatalf("buffers %d/%d, want 1/1", i0.BufferLen(), i1.BufferLen())
	}
	sys.Tick() // drain: pkg 5 wins the shared target slot
	if b2.Slot(0) == nil || b2.Slot(0).ID != 5 {
		t.Fatalf("tie-break loser won; b2 slot0 = %v", b2.Slot(0))
	}
	if i0.BufferLen() != 1 {
		t.Fatalf("loser buffer drained; want 1 pending")
	}
	sys.Tick() // pkg5 moves on; pkg10 transfers now
	if b2.Slot(0) == nil || b2.Slot(0).ID != 10 {
		t.Fatalf("loser did not transfer next tick")
	}
	sys.Tick()
	sys.Tick()
	got := ids(sys.Outputs())
	if !reflect.DeepEqual(got, []int{5, 10}) {
		t.Fatalf("outputs %v, want [5 10]", got)
	}
	if err := sys.VerifyConservation([]int{5, 10}); err != nil {
		t.Fatal(err)
	}
}

// A faulty belt pauses itself; other belts keep moving.
func TestFaultDoesNotStopOtherBelts(t *testing.T) {
	b0 := NewBelt(0, 4, 0)
	b1 := NewBelt(1, 4, 0)
	sys := NewSystem([]*Belt{b0, b1}, nil)
	sys.Inject(0, Package{ID: 1, DestBelt: 0, DestSlot: 3})
	sys.Inject(1, Package{ID: 2, DestBelt: 1, DestSlot: 3})
	sys.Tick() // both at slot 0

	b0.SetFault(2, true)
	var got []int
	for k := 0; k < 3; k++ {
		got = append(got, ids(sys.Tick())...)
	}
	if !reflect.DeepEqual(got, []int{2}) {
		t.Fatalf("outputs %v, want [2] (only healthy belt delivers)", got)
	}
	if b0.Slot(0) == nil || b0.Slot(0).ID != 1 {
		t.Fatalf("faulty belt moved, belt %v", b0)
	}
	b0.SetFault(2, false)
	for k := 0; k < 3; k++ {
		got = append(got, ids(sys.Tick())...)
	}
	if !reflect.DeepEqual(got, []int{2, 1}) {
		t.Fatalf("outputs %v, want [2 1]", got)
	}
}

// Random multi-belt scenarios must conserve packages at every tick and keep
// every package in exactly one location.
func TestRandomConservation(t *testing.T) {
	for seed := int64(0); seed < 40; seed++ {
		rng := rand.New(rand.NewSource(seed))
		belts := []*Belt{NewBelt(0, 3, 0), NewBelt(1, 4, 1), NewBelt(2, 2, 0)}
		ifaces := []*Interface{
			{ID: 1, FromBelt: 0, FromSlot: 2, ToBelt: 1, ToSlot: 0, Capacity: 2},
			{ID: 2, FromBelt: 1, FromSlot: 3, ToBelt: 2, ToSlot: 0, Capacity: 1},
			{ID: 3, FromBelt: 2, FromSlot: 1, ToBelt: 0, ToSlot: 1, Capacity: 1},
		}
		sys := NewSystem(belts, ifaces)
		nextID := 1
		var injected []int
		for tick := 0; tick < 250; tick++ {
			for k := 0; k < rng.Intn(3); k++ {
				p := Package{ID: nextID, DestBelt: rng.Intn(3)}
				nextID++
				p.DestSlot = rng.Intn(belts[p.DestBelt].Size())
				sys.Inject(rng.Intn(3), p)
				injected = append(injected, p.ID)
			}
			if rng.Intn(12) == 0 {
				b := belts[rng.Intn(3)]
				b.SetFault(rng.Intn(b.Size()), rng.Intn(2) == 0)
			}
			sys.Tick()
			if err := sys.VerifyConservation(injected); err != nil {
				t.Fatalf("seed %d tick %d: %v", seed, tick, err)
			}
		}
	}
}
