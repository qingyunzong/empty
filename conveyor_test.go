package conveyor

import (
	"math/rand"
	"reflect"
	"testing"
)

// refBelt is an independent list-based reference model of a single belt,
// used to cross-check the real implementation tick by tick.
type refBelt struct {
	slots []*Package
	queue []Package
}

func (r *refBelt) tick(beltID int, paused bool) []Package {
	if paused {
		return nil
	}
	n := len(r.slots)
	next := make([]*Package, n)
	for i, p := range r.slots {
		if p != nil {
			next[(i+1)%n] = p
		}
	}
	r.slots = next
	if len(r.queue) > 0 && r.slots[0] == nil {
		pkg := r.queue[0]
		r.queue = r.queue[1:]
		r.slots[0] = &pkg
	}
	var out []Package
	for i, p := range r.slots {
		if p != nil && p.Dest.Belt == beltID && p.Dest.Slot == i {
			out = append(out, *p)
			r.slots[i] = nil
		}
	}
	return out
}

func samePkgs(a, b []Package) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestWrapAround(t *testing.T) {
	belt := NewBelt(5)
	// Destination on another belt: the package circulates forever.
	belt.Enqueue(Package{ID: 1, Dest: Port{Belt: 1, Slot: 2}})
	wantPos := []int{0, 1, 2, 3, 4, 0, 1} // position after ticks 1..7
	for tick, want := range wantPos {
		belt.Tick()
		for i := 0; i < belt.Len(); i++ {
			p := belt.Slot(i)
			if i == want {
				if p == nil || p.ID != 1 {
					t.Fatalf("tick %d: want package 1 at slot %d, got %+v", tick+1, i, p)
				}
			} else if p != nil {
				t.Fatalf("tick %d: slot %d should be empty, got %+v", tick+1, i, p)
			}
		}
	}
}

func TestReferenceModel(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	for trial := 0; trial < 20; trial++ {
		n := 1 + rng.Intn(8)
		belt := NewBelt(n)
		ref := &refBelt{slots: make([]*Package, n)}
		id := 1
		var gotOut, wantOut []Package
		for tick := 0; tick < 200; tick++ {
			if rng.Intn(2) == 0 {
				dest := Port{Belt: 0, Slot: rng.Intn(n)}
				if rng.Intn(4) == 0 {
					dest = Port{Belt: 1, Slot: rng.Intn(n)} // never extracted here
				}
				pkg := Package{ID: id, Dest: dest}
				id++
				belt.Enqueue(pkg)
				ref.queue = append(ref.queue, pkg)
			}
			if rng.Intn(5) == 0 {
				belt.SetFault(rng.Intn(n), rng.Intn(2) == 0)
			}
			gotOut = append(gotOut, belt.Tick()...)
			wantOut = append(wantOut, ref.tick(0, belt.Paused())...)
			for i := 0; i < n; i++ {
				got, want := belt.Slot(i), ref.slots[i]
				if (got == nil) != (want == nil) || (got != nil && *got != *want) {
					t.Fatalf("trial %d tick %d slot %d: got %+v, want %+v", trial, tick, i, got, want)
				}
			}
			if got, want := belt.Queue(), ref.queue; !samePkgs(got, want) {
				t.Fatalf("trial %d tick %d: queue got %v, want %v", trial, tick, got, want)
			}
		}
		if !samePkgs(gotOut, wantOut) {
			t.Fatalf("trial %d: outputs got %v, want %v", trial, gotOut, wantOut)
		}
	}
}

func TestInjectQueuesWhenBlocked(t *testing.T) {
	belt := NewBelt(3)
	belt.Enqueue(Package{ID: 1, Dest: Port{0, 2}})
	belt.Enqueue(Package{ID: 2, Dest: Port{0, 1}})
	belt.Enqueue(Package{ID: 3, Dest: Port{0, 2}})

	belt.Tick() // p1 -> slot 0; p2, p3 queued behind the occupied input
	if p := belt.Slot(0); p == nil || p.ID != 1 {
		t.Fatalf("tick 1: slot 0 = %+v, want package 1", p)
	}
	if got := belt.QueueLen(); got != 2 {
		t.Fatalf("tick 1: queue len = %d, want 2", got)
	}

	belt.Tick() // p1 -> slot 1, p2 -> slot 0
	if got := belt.QueueLen(); got != 1 {
		t.Fatalf("tick 2: queue len = %d, want 1", got)
	}

	out := belt.Tick() // p1 -> slot 2, p2 -> slot 1 (both at destination), p3 -> slot 0
	if got := ids(out); !reflect.DeepEqual(got, []int{2, 1}) {
		t.Fatalf("tick 3: output = %v, want [2 1]", got)
	}
	if got := belt.QueueLen(); got != 0 {
		t.Fatalf("tick 3: queue len = %d, want 0", got)
	}

	belt.Tick()                       // p3 -> slot 1
	out = append(out, belt.Tick()...) // p3 -> slot 2 (extracted)
	if got := ids(out); !reflect.DeepEqual(got, []int{2, 1, 3}) {
		t.Fatalf("outputs = %v, want [2 1 3]", got)
	}
}

func ids(pkgs []Package) []int {
	out := make([]int, len(pkgs))
	for i, p := range pkgs {
		out[i] = p.ID
	}
	return out
}

func TestExtractAtInputSlot(t *testing.T) {
	belt := NewBelt(3)
	belt.Enqueue(Package{ID: 1, Dest: Port{0, 0}})
	out := belt.Tick() // injected into slot 0 and extracted in the same tick
	if len(out) != 1 || out[0].ID != 1 {
		t.Fatalf("output = %v, want [1]", out)
	}
	if p := belt.Slot(0); p != nil {
		t.Fatalf("slot 0 = %+v, want empty", p)
	}
}

func TestFaultPausesWholeBelt(t *testing.T) {
	belt := NewBelt(4)
	belt.Enqueue(Package{ID: 1, Dest: Port{0, 3}})
	belt.Tick() // p1 -> slot 0
	belt.Enqueue(Package{ID: 2, Dest: Port{0, 3}})

	belt.SetFault(2, true)
	if !belt.Paused() {
		t.Fatal("belt should be paused with a faulty slot")
	}
	for tick := 0; tick < 3; tick++ {
		if out := belt.Tick(); len(out) != 0 {
			t.Fatalf("paused belt produced output %v", out)
		}
		if p := belt.Slot(0); p == nil || p.ID != 1 {
			t.Fatalf("package moved while paused: slot 0 = %+v", p)
		}
		if got := belt.QueueLen(); got != 1 {
			t.Fatalf("queued package injected while paused: queue len = %d", got)
		}
	}

	belt.SetFault(2, false)
	belt.Tick() // p1 -> slot 1, p2 -> slot 0
	if p := belt.Slot(1); p == nil || p.ID != 1 {
		t.Fatalf("after resume: slot 1 = %+v, want package 1", p)
	}
	if p := belt.Slot(0); p == nil || p.ID != 2 {
		t.Fatalf("after resume: slot 0 = %+v, want package 2", p)
	}
}

func TestConservationSingleBelt(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	sys := NewSystem(4)
	injected := make(map[int]bool)
	id := 1
	for tick := 0; tick < 300; tick++ {
		if rng.Intn(3) > 0 {
			sys.Inject(0, Package{ID: id, Dest: Port{0, rng.Intn(4)}})
			injected[id] = true
			id++
		}
		if rng.Intn(6) == 0 {
			sys.Belt(0).SetFault(rng.Intn(4), rng.Intn(2) == 0)
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
