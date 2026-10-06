package objpool

import "testing"

func TestBorrowGetRelease(t *testing.T) {
	p := New[string](2, 8)
	h, ok := p.Borrow()
	if !ok {
		t.Fatal("borrow failed on fresh pool")
	}
	v, ok := p.Get(h)
	if !ok {
		t.Fatal("Get failed for live handle")
	}
	*v = "hello"
	if got, _ := p.Get(h); *got != "hello" {
		t.Fatalf("stored value not visible, got %q", *got)
	}
	if !p.Release(h) {
		t.Fatal("release failed for live handle")
	}
	if _, ok := p.Get(h); ok {
		t.Fatal("stale handle still grants access after release")
	}
	if p.Release(h) {
		t.Fatal("double release succeeded")
	}
}

func TestStaleHandleCannotReachReusedSlot(t *testing.T) {
	p := New[int](1, 8)
	h1, _ := p.Borrow()
	if !p.Release(h1) {
		t.Fatal("release failed")
	}
	h2, ok := p.Borrow()
	if !ok {
		t.Fatal("reborrow of freed slot failed")
	}
	if h2.Index != h1.Index {
		t.Fatalf("expected slot reuse, got %v then %v", h1, h2)
	}
	if h2.Gen == h1.Gen {
		t.Fatalf("generation not bumped on reuse: %v", h2)
	}
	if _, ok := p.Get(h1); ok {
		t.Fatal("old handle accessed reused slot")
	}
	if p.Release(h1) {
		t.Fatal("old handle released reused slot")
	}
	// The live handle is unaffected by stale-handle attempts.
	if _, ok := p.Get(h2); !ok {
		t.Fatal("live handle broken by stale handle activity")
	}
	if !p.Release(h2) {
		t.Fatal("live handle release failed")
	}
}

func TestZeroHandleNeverValid(t *testing.T) {
	p := New[int](4, 8)
	if _, ok := p.Get(Handle{}); ok {
		t.Fatal("zero handle granted access")
	}
	if p.Release(Handle{}) {
		t.Fatal("zero handle released a slot")
	}
	// Even with slot 0 borrowed at its first generation, zero handle must fail.
	h, _ := p.Borrow()
	if _, ok := p.Get(Handle{}); ok {
		t.Fatalf("zero handle collided with live handle %v", h)
	}
}

func TestOutOfRangeHandle(t *testing.T) {
	p := New[int](1, 8)
	h, _ := p.Borrow()
	bogus := Handle{Index: h.Index + 100, Gen: h.Gen}
	if _, ok := p.Get(bogus); ok {
		t.Fatal("out-of-range handle granted access")
	}
	if p.Release(bogus) {
		t.Fatal("out-of-range handle released")
	}
}

func TestBorrowNAllOrNothing(t *testing.T) {
	p := New[int](3, 8)
	if _, ok := p.BorrowN(4); ok {
		t.Fatal("BorrowN larger than capacity succeeded")
	}
	if got := p.Available(); got != 3 {
		t.Fatalf("failed BorrowN changed pool: available=%d", got)
	}

	hs, ok := p.BorrowN(2)
	if !ok || len(hs) != 2 {
		t.Fatalf("BorrowN(2) failed: ok=%v n=%d", ok, len(hs))
	}
	if _, ok := p.BorrowN(2); ok {
		t.Fatal("BorrowN exceeding availability succeeded")
	}
	// All-or-nothing: the one remaining slot must still be there.
	if got := p.Available(); got != 1 {
		t.Fatalf("failed BorrowN leaked borrows: available=%d", got)
	}
	if _, ok := p.BorrowN(-1); ok {
		t.Fatal("negative BorrowN succeeded")
	}
	for _, h := range hs {
		if !p.Release(h) {
			t.Fatalf("release of %v failed", h)
		}
	}
	if got := p.Available(); got != 3 {
		t.Fatalf("available=%d after releases, want 3", got)
	}
}

func TestShrinkRetiresOnlyFreeSlots(t *testing.T) {
	p := New[int](5, 8)
	borrowed, ok := p.BorrowN(2)
	if !ok {
		t.Fatal("setup borrow failed")
	}
	// Ask to shrink more than the free count: only the 3 free slots go.
	if n := p.Shrink(10); n != 3 {
		t.Fatalf("Shrink retired %d, want 3", n)
	}
	if got := p.Available(); got != 0 {
		t.Fatalf("available=%d after shrink, want 0", got)
	}
	if got := p.Borrowed(); got != 2 {
		t.Fatalf("borrowed=%d after shrink, want 2", got)
	}
	// Borrowed slots survive the shrink and remain fully usable.
	for _, h := range borrowed {
		if _, ok := p.Get(h); !ok {
			t.Fatalf("borrowed handle %v killed by shrink", h)
		}
	}
	// Releasing them returns them to service (generations are far from overflow).
	for _, h := range borrowed {
		if !p.Release(h) {
			t.Fatalf("release of %v failed", h)
		}
	}
	if got := p.Available(); got != 2 {
		t.Fatalf("available=%d after releasing survivors, want 2", got)
	}
	if got := p.Retired(); got != 3 {
		t.Fatalf("retired=%d, want 3", got)
	}
	// Retired slots never come back.
	if n := p.Shrink(100); n != 2 {
		t.Fatalf("second shrink retired %d, want 2", n)
	}
	if got := p.Capacity(); got != 5 {
		t.Fatalf("capacity=%d, want 5", got)
	}
}

// TestGenerationOverflowExhaustive uses a tiny generation width so every
// reachable generation of every slot is enumerated. After each release it
// verifies that every handle ever issued for the pool is dead, and once a
// slot's generation overflows it must be retired permanently.
func TestGenerationOverflowExhaustive(t *testing.T) {
	const (
		capacity = 3
		genBits  = 2 // generations 1..3, i.e. 3 borrows per slot before overflow
	)
	p := New[int](capacity, genBits)

	var allHandles []Handle
	uses := make(map[uint32]int)

	for {
		h, ok := p.Borrow()
		if !ok {
			break
		}
		allHandles = append(allHandles, h)
		uses[h.Index]++
		if uses[h.Index] > (1<<genBits)-1 {
			t.Fatalf("slot %d borrowed more than maxGen times", h.Index)
		}
		// The handle just issued must be the only live one for its slot.
		for _, old := range allHandles[:len(allHandles)-1] {
			if _, ok := p.Get(old); ok {
				t.Fatalf("stale handle %v still valid while %v is live", old, h)
			}
		}
		if !p.Release(h) {
			t.Fatalf("release of live handle %v failed", h)
		}
		// After release, every handle issued so far (including h) is dead.
		for _, old := range allHandles {
			if _, ok := p.Get(old); ok {
				t.Fatalf("handle %v valid after its release", old)
			}
			if p.Release(old) {
				t.Fatalf("handle %v released twice", old)
			}
		}
	}

	// Every slot must have been used exactly maxGen times, then retired.
	for idx := uint32(0); idx < capacity; idx++ {
		if uses[idx] != (1<<genBits)-1 {
			t.Fatalf("slot %d used %d times, want %d", idx, uses[idx], (1<<genBits)-1)
		}
	}
	if got := p.Retired(); got != capacity {
		t.Fatalf("retired=%d, want %d (all slots must die on generation overflow)", got, capacity)
	}
	if got := p.Available(); got != 0 {
		t.Fatalf("available=%d in exhausted pool", got)
	}
	// The pool stays exhausted: overflowed slots never recycle.
	if _, ok := p.Borrow(); ok {
		t.Fatal("borrow succeeded from generation-exhausted pool")
	}
	for _, h := range allHandles {
		if _, ok := p.Get(h); ok {
			t.Fatalf("handle %v resurrected in exhausted pool", h)
		}
	}
}

func TestShrinkThenOverflowInterplay(t *testing.T) {
	p := New[int](2, 1) // maxGen=1: each slot survives exactly one borrow
	h, ok := p.Borrow()
	if !ok {
		t.Fatal("borrow failed")
	}
	if n := p.Shrink(1); n != 1 {
		t.Fatalf("shrink retired %d, want 1 (only the free slot)", n)
	}
	if !p.Release(h) {
		t.Fatal("release failed")
	}
	// h's slot hit its generation limit on release and retired too.
	if got := p.Retired(); got != 2 {
		t.Fatalf("retired=%d, want 2", got)
	}
	if _, ok := p.Borrow(); ok {
		t.Fatal("borrow from fully retired pool succeeded")
	}
}
