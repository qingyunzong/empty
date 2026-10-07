package conveyor

import (
	"encoding/json"
	"math/rand"
	"reflect"
	"testing"
)

// Snapshot mid-run, restore, and verify both copies evolve identically,
// including belt positions and cross-belt pending transfers.
func TestSnapshotRestoreDeterminism(t *testing.T) {
	for seed := int64(0); seed < 30; seed++ {
		rng := rand.New(rand.NewSource(seed))
		belts := []*Belt{NewBelt(0, 3, 0), NewBelt(1, 4, 1), NewBelt(2, 3, 0)}
		ifaces := []*Interface{
			{ID: 1, FromBelt: 0, FromSlot: 2, ToBelt: 1, ToSlot: 0, Capacity: 2},
			{ID: 2, FromBelt: 1, FromSlot: 3, ToBelt: 2, ToSlot: 1, Capacity: 1},
		}
		sys := NewSystem(belts, ifaces)
		nextID := 1
		var injected []int
		type injectOp struct {
			belt int
			pkg  Package
		}
		type faultOp struct {
			belt, slot int
			on         bool
		}
		genOps := func() ([]injectOp, []faultOp) {
			var ins []injectOp
			for k := 0; k < rng.Intn(3); k++ {
				p := Package{ID: nextID, DestBelt: rng.Intn(3)}
				nextID++
				p.DestSlot = rng.Intn(3)
				ins = append(ins, injectOp{belt: rng.Intn(3), pkg: p})
				injected = append(injected, p.ID)
			}
			var faults []faultOp
			if rng.Intn(10) == 0 {
				bi := rng.Intn(3)
				faults = append(faults, faultOp{belt: bi, slot: rng.Intn(belts[bi].Size()), on: rng.Intn(2) == 0})
			}
			return ins, faults
		}
		apply := func(s *System, ins []injectOp, faults []faultOp) {
			for _, op := range ins {
				s.Inject(op.belt, op.pkg)
			}
			for _, f := range faults {
				s.Belt(f.belt).SetFault(f.slot, f.on)
			}
		}
		for tick := 0; tick < 40; tick++ {
			ins, faults := genOps()
			apply(sys, ins, faults)
			sys.Tick()
		}

		snap := sys.Snapshot()
		data, err := json.Marshal(snap)
		if err != nil {
			t.Fatalf("seed %d: snapshot not serializable: %v", seed, err)
		}
		var wire Snapshot
		if err := json.Unmarshal(data, &wire); err != nil {
			t.Fatalf("seed %d: snapshot not deserializable: %v", seed, err)
		}
		clone := Restore(wire)

		for tick := 0; tick < 60; tick++ {
			ins, faults := genOps()
			apply(sys, ins, faults)
			apply(clone, ins, faults)
			gotA := sys.Tick()
			gotB := clone.Tick()
			if !reflect.DeepEqual(gotA, gotB) {
				t.Fatalf("seed %d tick %d: outputs diverged %v vs %v", seed, tick, gotA, gotB)
			}
		}
		locA, locB := sys.Locations(), clone.Locations()
		if !reflect.DeepEqual(locA, locB) {
			t.Fatalf("seed %d: locations diverged\n%v\n%v", seed, locA, locB)
		}
		if err := clone.VerifyConservation(injected); err != nil {
			t.Fatalf("seed %d: restored system: %v", seed, err)
		}
	}
}

// A package pending inside an interface buffer survives a snapshot round
// trip and completes its transfer afterwards.
func TestSnapshotPreservesPendingTransfer(t *testing.T) {
	b0 := NewBelt(0, 2, 0)
	b1 := NewBelt(1, 3, 0)
	iface := &Interface{ID: 1, FromBelt: 0, FromSlot: 0, ToBelt: 1, ToSlot: 0, Capacity: 2}
	sys := NewSystem([]*Belt{b0, b1}, []*Interface{iface})
	b0.SetFault(1, true)
	sys.Inject(0, Package{ID: 1, DestBelt: 1, DestSlot: 2})
	sys.Tick() // pkg1 at b0 slot0
	sys.Tick() // pkg1 pending in interface buffer
	if iface.BufferLen() != 1 {
		t.Fatalf("buffer len %d, want 1", iface.BufferLen())
	}

	clone := Restore(sys.Snapshot())
	cIface := clone.Interfaces()[0]
	if cIface.BufferLen() != 1 {
		t.Fatalf("restored buffer len %d, want 1", cIface.BufferLen())
	}
	clone.Tick() // drain: pkg1 -> b1 slot0
	if got := clone.Belt(1).Slot(0); got == nil || got.ID != 1 {
		t.Fatalf("pending transfer lost after restore")
	}
	clone.Tick()
	out := clone.Tick()
	if !reflect.DeepEqual(ids(out), []int{1}) {
		t.Fatalf("outputs %v, want [1]", ids(out))
	}
	if err := clone.VerifyConservation([]int{1}); err != nil {
		t.Fatal(err)
	}
	// Unique position: pkg1 appears exactly once across all locations.
	loc := clone.Locations()
	if len(loc) != 1 || loc[1] == "" {
		t.Fatalf("unique position violated: %v", loc)
	}
}
