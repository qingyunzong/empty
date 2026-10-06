package conveyor

import (
	"math/rand"
	"reflect"
	"testing"
)

func assertSlot(t *testing.T, sys *System, belt, slot, wantID int) {
	t.Helper()
	p := sys.Belt(belt).Slot(slot)
	if p == nil || p.ID != wantID {
		t.Fatalf("belt %d slot %d: want package %d, got %+v", belt, slot, wantID, p)
	}
}

func assertBeltEmpty(t *testing.T, sys *System, belt int) {
	t.Helper()
	for i := 0; i < sys.Belt(belt).Len(); i++ {
		if p := sys.Belt(belt).Slot(i); p != nil {
			t.Fatalf("belt %d slot %d: want empty, got %+v", belt, i, p)
		}
	}
}

func assertOutputs(t *testing.T, sys *System, wantIDs ...int) {
	t.Helper()
	out := sys.Outputs()
	if len(out) != len(wantIDs) {
		t.Fatalf("outputs = %v, want IDs %v", out, wantIDs)
	}
	for i, id := range wantIDs {
		if out[i].ID != id {
			t.Fatalf("outputs = %v, want IDs %v", out, wantIDs)
		}
	}
}

func TestTransferBasic(t *testing.T) {
	sys := NewSystem(4, 4)
	if err := sys.AddLink(TransferLink{From: Port{0, 1}, To: Port{1, 1}, Capacity: 2}); err != nil {
		t.Fatal(err)
	}
	sys.Inject(0, Package{ID: 1, Dest: Port{1, 3}})

	sys.Tick() // X injected at A slot 0
	assertSlot(t, sys, 0, 0, 1)

	sys.Tick() // X moves to A slot 1, then transfers to B slot 1
	assertBeltEmpty(t, sys, 0)
	assertSlot(t, sys, 1, 1, 1)

	sys.Tick() // X rides belt B
	assertSlot(t, sys, 1, 2, 1)

	sys.Tick() // X reaches its destination B slot 3 and is extracted
	assertOutputs(t, sys, 1)
	assertBeltEmpty(t, sys, 1)
}

func TestTransferWaitsForEmptyTarget(t *testing.T) {
	sys := NewSystem(3, 4)
	if err := sys.AddLink(TransferLink{From: Port{0, 1}, To: Port{1, 1}, Capacity: 1}); err != nil {
		t.Fatal(err)
	}
	sys.Inject(0, Package{ID: 1, Dest: Port{1, 0}}) // X, wants belt B
	sys.Inject(1, Package{ID: 9, Dest: Port{1, 3}}) // blocker, stays on belt B

	sys.Tick() // X -> A s0, blocker -> B s0
	sys.Tick() // X -> A s1, blocker -> B s1; target occupied: X diverts to pending
	if got := sys.PendingCount(0); got != 1 {
		t.Fatalf("pending = %d, want 1", got)
	}
	assertBeltEmpty(t, sys, 0)

	sys.Tick() // blocker -> B s2; pending X transfers into freed B s1
	if got := sys.PendingCount(0); got != 0 {
		t.Fatalf("pending = %d, want 0", got)
	}
	assertSlot(t, sys, 1, 1, 1)

	sys.Tick() // blocker -> B s3 (extracted), X -> B s2
	assertOutputs(t, sys, 9)
	sys.Tick() // X -> B s3
	sys.Tick() // X -> B s0 (wrap) and extracted
	assertOutputs(t, sys, 9, 1)
}

func TestTransferTieBreakByPackageID(t *testing.T) {
	sys := NewSystem(3, 3, 6)
	if err := sys.AddLink(TransferLink{From: Port{0, 1}, To: Port{2, 1}, Capacity: 1}); err != nil {
		t.Fatal(err)
	}
	if err := sys.AddLink(TransferLink{From: Port{1, 1}, To: Port{2, 1}, Capacity: 1}); err != nil {
		t.Fatal(err)
	}
	sys.Inject(0, Package{ID: 7, Dest: Port{2, 4}}) // high ID on belt A
	sys.Inject(1, Package{ID: 2, Dest: Port{2, 5}}) // low ID on belt B

	sys.Tick() // both packages injected at slot 0 of their belts
	sys.Tick() // both reach slot 1 and compete for C slot 1: ID 2 wins
	assertSlot(t, sys, 2, 1, 2)
	if got := sys.PendingCount(0); got != 1 {
		t.Fatalf("loser should wait in link 0 pending buffer, pending = %d", got)
	}
	if got := sys.PendingCount(1); got != 0 {
		t.Fatalf("winner link should be empty, pending = %d", got)
	}

	sys.Tick() // package 2 rides on; pending package 7 takes freed C slot 1
	assertSlot(t, sys, 2, 1, 7)
	assertSlot(t, sys, 2, 2, 2)
}

func TestNoDoubleTransferSameTick(t *testing.T) {
	sys := NewSystem(3, 3, 3)
	if err := sys.AddLink(TransferLink{From: Port{0, 1}, To: Port{1, 1}, Capacity: 1}); err != nil {
		t.Fatal(err)
	}
	if err := sys.AddLink(TransferLink{From: Port{1, 1}, To: Port{2, 1}, Capacity: 1}); err != nil {
		t.Fatal(err)
	}
	sys.Inject(0, Package{ID: 1, Dest: Port{2, 2}})

	sys.Tick() // X -> A s0
	sys.Tick() // X -> A s1, transfers to B s1; must NOT continue to C this tick
	assertSlot(t, sys, 1, 1, 1)
	assertBeltEmpty(t, sys, 2)

	sys.Tick() // X -> B s2 (moved past the second link's source)
	assertSlot(t, sys, 1, 2, 1)
	assertBeltEmpty(t, sys, 2)

	sys.Tick() // X -> B s0
	sys.Tick() // X -> B s1, transfers to C s1
	assertSlot(t, sys, 2, 1, 1)

	sys.Tick() // X -> C s2, extracted at destination
	assertOutputs(t, sys, 1)
}

func TestFaultDoesNotStopOtherBelts(t *testing.T) {
	sys := NewSystem(4, 4)
	if err := sys.AddLink(TransferLink{From: Port{1, 1}, To: Port{0, 1}, Capacity: 1}); err != nil {
		t.Fatal(err)
	}
	sys.Inject(0, Package{ID: 1, Dest: Port{0, 2}}) // stays on belt A
	sys.Inject(1, Package{ID: 2, Dest: Port{0, 2}}) // wants belt A

	sys.Tick() // pA -> A s0, pB -> B s0
	sys.Belt(0).SetFault(2, true)

	for tick := 0; tick < 3; tick++ {
		sys.Tick()
		assertSlot(t, sys, 0, 0, 1) // belt A frozen
	}
	assertSlot(t, sys, 1, 3, 2) // belt B kept moving: s1, s2, s3
	if got := sys.PendingCount(0); got != 0 {
		t.Fatalf("transfers to a paused belt must be suspended, pending = %d", got)
	}

	sys.Belt(0).SetFault(2, false)
	sys.Tick() // pA -> A s1; pB -> B s0
	sys.Tick() // pA -> A s2 (extracted); pB -> B s1, transfers to A s1
	assertOutputs(t, sys, 1)
	assertSlot(t, sys, 0, 1, 2)

	sys.Tick() // pB -> A s2, extracted
	assertOutputs(t, sys, 1, 2)
}

func TestSnapshotRestore(t *testing.T) {
	sizes := []int{3, 4, 5}
	build := func() *System {
		sys := NewSystem(sizes...)
		if err := sys.AddLink(TransferLink{From: Port{0, 1}, To: Port{1, 1}, Capacity: 2}); err != nil {
			t.Fatal(err)
		}
		if err := sys.AddLink(TransferLink{From: Port{1, 2}, To: Port{2, 2}, Capacity: 1}); err != nil {
			t.Fatal(err)
		}
		if err := sys.AddLink(TransferLink{From: Port{0, 2}, To: Port{2, 3}, Capacity: 0}); err != nil {
			t.Fatal(err)
		}
		return sys
	}
	runPhase := func(sys *System, rng *rand.Rand, ticks int, id *int) {
		for i := 0; i < ticks; i++ {
			if rng.Intn(4) > 0 {
				b := rng.Intn(len(sizes))
				d := rng.Intn(len(sizes))
				sys.Inject(b, Package{ID: *id, Dest: Port{d, rng.Intn(sizes[d])}})
				*id++
			}
			if rng.Intn(4) == 0 {
				b := rng.Intn(len(sizes))
				sys.Belt(b).SetFault(rng.Intn(sizes[b]), rng.Intn(2) == 0)
			}
			sys.Tick()
		}
	}

	sys := build()
	id := 1
	runPhase(sys, rand.New(rand.NewSource(1)), 30, &id)
	snap := sys.Snapshot()
	idAtSnap := id
	pendingAtSnap := 0
	for _, ls := range snap.Links {
		pendingAtSnap += len(ls.Pending)
	}
	if pendingAtSnap == 0 {
		t.Fatal("scenario should have cross-belt pending transfers at snapshot time")
	}

	runPhase(sys, rand.New(rand.NewSource(2)), 20, &id)
	want := sys.Snapshot()

	if err := sys.Restore(snap); err != nil {
		t.Fatal(err)
	}
	if got := sys.TickCount(); got != snap.Tick {
		t.Fatalf("tick counter after restore = %d, want %d", got, snap.Tick)
	}
	id = idAtSnap
	runPhase(sys, rand.New(rand.NewSource(2)), 20, &id)
	got := sys.Snapshot()

	if !reflect.DeepEqual(want, got) {
		t.Fatalf("state diverged after restore\nwant: %+v\ngot:  %+v", want, got)
	}
}

func TestRestoreShapeMismatch(t *testing.T) {
	sys := NewSystem(3, 4)
	if err := sys.AddLink(TransferLink{From: Port{0, 1}, To: Port{1, 1}, Capacity: 1}); err != nil {
		t.Fatal(err)
	}
	other := NewSystem(3, 4, 5)
	if err := sys.Restore(other.Snapshot()); err == nil {
		t.Fatal("restore with wrong belt count should fail")
	}
	other = NewSystem(3, 5)
	if err := sys.Restore(other.Snapshot()); err == nil {
		t.Fatal("restore with wrong belt size should fail")
	}
	other = NewSystem(3, 4)
	if err := sys.Restore(other.Snapshot()); err == nil {
		t.Fatal("restore with wrong link count should fail")
	}
}

func TestAddLinkValidation(t *testing.T) {
	sys := NewSystem(3)
	if err := sys.AddLink(TransferLink{From: Port{0, 0}, To: Port{1, 0}}); err == nil {
		t.Fatal("link to unknown belt should fail")
	}
	if err := sys.AddLink(TransferLink{From: Port{0, 0}, To: Port{0, 3}}); err == nil {
		t.Fatal("link to out-of-range slot should fail")
	}
	if err := sys.AddLink(TransferLink{From: Port{0, 0}, To: Port{0, 1}, Capacity: -1}); err == nil {
		t.Fatal("negative capacity should fail")
	}
	if err := sys.AddLink(TransferLink{From: Port{0, 0}, To: Port{0, 1}}); err != nil {
		t.Fatalf("valid link rejected: %v", err)
	}
}

func TestPackageUniqueLocation(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	sizes := []int{3, 4, 5}
	sys := NewSystem(sizes...)
	if err := sys.AddLink(TransferLink{From: Port{0, 1}, To: Port{1, 1}, Capacity: 2}); err != nil {
		t.Fatal(err)
	}
	if err := sys.AddLink(TransferLink{From: Port{1, 2}, To: Port{2, 2}, Capacity: 1}); err != nil {
		t.Fatal(err)
	}
	injected := make(map[int]bool)
	id := 1
	for tick := 0; tick < 300; tick++ {
		if rng.Intn(3) > 0 {
			b := rng.Intn(len(sizes))
			d := rng.Intn(len(sizes))
			sys.Inject(b, Package{ID: id, Dest: Port{d, rng.Intn(sizes[d])}})
			injected[id] = true
			id++
		}
		if rng.Intn(6) == 0 {
			b := rng.Intn(len(sizes))
			sys.Belt(b).SetFault(rng.Intn(sizes[b]), rng.Intn(2) == 0)
		}
		sys.Tick()
		locs, err := sys.Locations()
		if err != nil {
			t.Fatalf("tick %d: %v", tick, err)
		}
		if len(locs) != len(injected) {
			t.Fatalf("tick %d: %d packages located, %d injected", tick, len(locs), len(injected))
		}
		for pkgID := range injected {
			if _, ok := locs[pkgID]; !ok {
				t.Fatalf("tick %d: package %d lost", tick, pkgID)
			}
		}
	}
}
