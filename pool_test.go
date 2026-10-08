package genpool

import (
	"fmt"
	"sync"
	"testing"
)

func newIntPool(t *testing.T, capacity int, genBits uint) *Pool[int] {
	t.Helper()
	p, err := New(func() int { return 0 }, capacity, genBits)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return p
}

func mustBorrow(t *testing.T, p *Pool[int]) Handle {
	t.Helper()
	h, ok := p.Borrow()
	if !ok {
		t.Fatal("Borrow failed unexpectedly")
	}
	return h
}

func TestBorrowGetRelease(t *testing.T) {
	p := newIntPool(t, 2, 8)

	h := mustBorrow(t, p)
	v, ok := p.Get(h)
	if !ok {
		t.Fatalf("Get(%v) failed on live handle", h)
	}
	*v = 42
	v2, ok := p.Get(h)
	if !ok || *v2 != 42 {
		t.Fatalf("Get after mutation = %v, %v; want 42, true", v2, ok)
	}
	if !p.Release(h) {
		t.Fatalf("Release(%v) failed on live handle", h)
	}
}

func TestStaleHandleCannotAccessReusedSlot(t *testing.T) {
	p := newIntPool(t, 1, 8)

	old := mustBorrow(t, p)
	if !p.Release(old) {
		t.Fatal("release failed")
	}

	// Slot is reused: same index, bumped generation.
	reused := mustBorrow(t, p)
	if reused.Index != old.Index {
		t.Fatalf("reused handle index = %d, want %d", reused.Index, old.Index)
	}
	if reused.Gen == old.Gen {
		t.Fatalf("generation not bumped after release: %v", reused)
	}

	// The old handle must not read, write, or release the reused slot.
	if _, ok := p.Get(old); ok {
		t.Fatalf("stale handle %v accessed reused slot", old)
	}
	if p.Release(old) {
		t.Fatalf("stale handle %v released reused slot (double free)", old)
	}

	// The new handle still works.
	if _, ok := p.Get(reused); !ok {
		t.Fatalf("live handle %v rejected", reused)
	}
	if !p.Release(reused) {
		t.Fatalf("live handle %v release failed", reused)
	}
}

func TestZeroAndOutOfRangeHandlesInvalid(t *testing.T) {
	p := newIntPool(t, 1, 8)
	for _, h := range []Handle{{}, {Index: 0, Gen: 1}, {Index: 5, Gen: 1}, {Index: ^uint32(0), Gen: 1}} {
		// {Index:0, Gen:1} is only invalid here because it is not borrowed.
		if _, ok := p.Get(h); ok {
			t.Errorf("Get(%v) succeeded, want failure", h)
		}
		if p.Release(h) {
			t.Errorf("Release(%v) succeeded, want failure", h)
		}
	}
}

func TestBorrowNAllOrNothing(t *testing.T) {
	p := newIntPool(t, 3, 8)

	h1 := mustBorrow(t, p) // 2 free remain

	// Ask for more than available: nothing may be borrowed.
	got, ok := p.BorrowN(3)
	if ok || got != nil {
		t.Fatalf("BorrowN(3) = %v, %v; want nil, false", got, ok)
	}
	if cap_, free, borrowed, retired := p.Stats(); cap_ != 3 || free != 2 || borrowed != 1 || retired != 0 {
		t.Fatalf("stats after failed BorrowN = %d/%d/%d/%d, want 3/2/1/0", cap_, free, borrowed, retired)
	}

	// Ask for exactly what is available: succeeds.
	hs, ok := p.BorrowN(2)
	if !ok || len(hs) != 2 {
		t.Fatalf("BorrowN(2) = %v, %v; want 2 handles, true", hs, ok)
	}
	seen := map[Handle]bool{h1: true}
	for _, h := range hs {
		if seen[h] {
			t.Fatalf("duplicate handle %v", h)
		}
		seen[h] = true
	}
	if _, ok := p.BorrowN(1); ok {
		t.Fatal("BorrowN(1) succeeded on exhausted pool")
	}
}

func TestShrinkRetiresOnlyEmptySlots(t *testing.T) {
	p := newIntPool(t, 4, 8)

	live := mustBorrow(t, p) // 1 borrowed, 3 free

	// Shrink more than the number of free slots: only the 3 empty ones retire.
	if n := p.Shrink(10); n != 3 {
		t.Fatalf("Shrink(10) retired %d slots, want 3", n)
	}
	if cap_, free, borrowed, retired := p.Stats(); cap_ != 4 || free != 0 || borrowed != 1 || retired != 3 {
		t.Fatalf("stats = %d/%d/%d/%d, want 4/0/1/3", cap_, free, borrowed, retired)
	}

	// The borrowed slot survives shrinking and remains fully usable.
	if _, ok := p.Get(live); !ok {
		t.Fatalf("borrowed handle %v broken by Shrink", live)
	}
	if !p.Release(live) {
		t.Fatalf("release of %v failed after Shrink", live)
	}

	// Once released it becomes empty and can be retired by a later Shrink.
	if n := p.Shrink(1); n != 1 {
		t.Fatalf("second Shrink retired %d, want 1", n)
	}
	if _, ok := p.Borrow(); ok {
		t.Fatal("Borrow succeeded with every slot retired")
	}
}

func TestGenerationOverflowRetiresSlotPermanently(t *testing.T) {
	const genBits = 2 // maxGen = 3: a slot survives exactly 3 borrow cycles
	p := newIntPool(t, 1, genBits)

	var issued []Handle
	for cycle := 1; cycle <= 3; cycle++ {
		h := mustBorrow(t, p)
		if h.Gen != uint32(cycle) {
			t.Fatalf("cycle %d: gen = %d, want %d", cycle, h.Gen, cycle)
		}
		issued = append(issued, h)
		if !p.Release(h) {
			t.Fatalf("cycle %d: release failed", cycle)
		}
	}

	// Generation 3 was the last: the slot is now retired forever.
	if _, ok := p.Borrow(); ok {
		t.Fatal("Borrow succeeded after generation overflow; slot must be permanently disabled")
	}
	if _, _, _, retired := p.Stats(); retired != 1 {
		t.Fatalf("retired = %d, want 1", retired)
	}

	// Every handle ever issued for this slot is dead.
	for _, h := range issued {
		if _, ok := p.Get(h); ok {
			t.Errorf("Get(%v) succeeded on retired slot", h)
		}
		if p.Release(h) {
			t.Errorf("Release(%v) succeeded on retired slot", h)
		}
	}
}

// TestExhaustiveHandleSpace scans the entire handle space of a tiny
// generation width and checks that exactly the live handle is accepted.
func TestExhaustiveHandleSpace(t *testing.T) {
	const genBits = 2
	p := newIntPool(t, 2, genBits)

	live := mustBorrow(t, p)
	maxGen := uint32(1<<genBits - 1)

	for idx := uint32(0); idx <= uint32(len(p.slots)); idx++ { // includes out-of-range index
		for gen := uint32(0); gen <= maxGen+1; gen++ { // includes gen 0 and overflow gen
			h := Handle{Index: idx, Gen: gen}
			wantValid := h == live
			if _, ok := p.Get(h); ok != wantValid {
				t.Errorf("Get(%v) = %v, want %v", h, ok, wantValid)
			}
			if !wantValid && p.Release(h) {
				t.Errorf("Release(%v) succeeded, want failure", h)
			}
		}
	}
	if !p.Release(live) {
		t.Fatalf("Release(%v) failed on the one live handle", live)
	}
}

// TestExhaustiveLifecycle drives a 1-bit-generation pool to total exhaustion
// and verifies every stale handle at every step.
func TestExhaustiveLifecycle(t *testing.T) {
	const (
		capacity = 3
		genBits  = 1 // maxGen = 1: each slot survives exactly one release
	)
	p := newIntPool(t, capacity, genBits)

	var stale []Handle
	for i := 0; i < capacity; i++ {
		h := mustBorrow(t, p)
		if !p.Release(h) { // gen 1 -> overflow -> slot retired
			t.Fatalf("release %d failed", i)
		}
		stale = append(stale, h)

		// Re-verify the whole stale set after every state change.
		for _, s := range stale {
			if _, ok := p.Get(s); ok {
				t.Fatalf("stale handle %v still readable", s)
			}
			if p.Release(s) {
				t.Fatalf("stale handle %v still releasable", s)
			}
		}
	}

	if _, ok := p.Borrow(); ok {
		t.Fatal("Borrow succeeded on fully retired pool")
	}
	if cap_, free, borrowed, retired := p.Stats(); cap_ != capacity || free != 0 || borrowed != 0 || retired != capacity {
		t.Fatalf("stats = %d/%d/%d/%d, want %d/0/0/%d", cap_, free, borrowed, retired, capacity, capacity)
	}
}

func TestConcurrentUse(t *testing.T) {
	p := newIntPool(t, 16, 8)
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				h, ok := p.Borrow()
				if !ok {
					continue
				}
				v, ok := p.Get(h)
				if !ok {
					t.Errorf("Get(%v) failed on live handle", h)
					return
				}
				*v = id
				if !p.Release(h) {
					t.Errorf("Release(%v) failed on live handle", h)
					return
				}
			}
		}(w)
	}
	wg.Wait()
	if _, free, borrowed, _ := p.Stats(); borrowed != 0 || free == 0 {
		t.Fatalf("after concurrent use: borrowed=%d free=%d", borrowed, free)
	}
}

func TestNewValidation(t *testing.T) {
	if _, err := New(func() int { return 0 }, -1, 8); err == nil {
		t.Error("negative capacity accepted")
	}
	for _, bits := range []uint{0, 33} {
		if _, err := New(func() int { return 0 }, 1, bits); err == nil {
			t.Errorf("genBits=%d accepted", bits)
		}
	}
	if _, err := New(func() int { return 0 }, 0, 1); err != nil {
		t.Errorf("empty pool rejected: %v", err)
	}
}

func ExamplePool() {
	p, _ := New(func() string { return "obj" }, 1, 4)
	h, _ := p.Borrow()
	v, _ := p.Get(h)
	*v = "in use"
	p.Release(h)

	// h is stale now; the slot may be reused, but never through h.
	fmt.Println(p.Get(h))
	// Output: <nil> false
}
