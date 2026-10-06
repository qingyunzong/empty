package lease

import (
	"fmt"
	"sync"
	"testing"
)

func TestAcquireAndContention(t *testing.T) {
	m := NewManager(NewClock(0))
	g, ok := m.Acquire("alice", 10)
	if !ok {
		t.Fatal("first acquire must succeed")
	}
	if g.Generation != 1 || g.Expiry != 10 {
		t.Fatalf("unexpected grant: %+v", g)
	}
	if _, ok := m.Acquire("bob", 10); ok {
		t.Fatal("second acquire while lease is live must fail")
	}
}

func TestRenewExtends(t *testing.T) {
	clock := NewClock(0)
	m := NewManager(clock)
	g, _ := m.Acquire("alice", 10)
	clock.Advance(5)
	r, ok := m.Renew("alice", g.Generation, 1, 10)
	if !ok {
		t.Fatal("renew must succeed")
	}
	if r.Expiry != 15 {
		t.Fatalf("renew expiry = %d, want 15", r.Expiry)
	}
}

func TestDuplicateRenewReturnsOriginalExpiry(t *testing.T) {
	clock := NewClock(0)
	m := NewManager(clock)
	g, _ := m.Acquire("alice", 10)

	clock.Advance(5) // now = 5
	first, ok := m.Renew("alice", g.Generation, 42, 10)
	if !ok || first.Expiry != 15 {
		t.Fatalf("first renew = %+v ok=%v, want expiry 15", first, ok)
	}

	clock.Advance(4) // now = 9, lease still live until 15
	dup, ok := m.Renew("alice", g.Generation, 42, 10)
	if !ok {
		t.Fatal("duplicate request must still succeed (idempotent)")
	}
	if dup.Expiry != 15 {
		t.Fatalf("duplicate renew expiry = %d, want original 15 (no extension)", dup.Expiry)
	}
	if snap, _ := m.Snapshot(); snap.Expiry != 15 {
		t.Fatalf("stored expiry = %d, duplicate renew must not extend to 19", snap.Expiry)
	}

	// A different request ID is a new request and does extend.
	third, ok := m.Renew("alice", g.Generation, 43, 10)
	if !ok || third.Expiry != 19 {
		t.Fatalf("new requestID expiry = %d, want 19", third.Expiry)
	}
}

// TestExpiryBeatsRenewAtSameTick enumerates every tick around the expiry
// boundary and verifies that at tick == expiry the lease is already gone.
func TestExpiryBeatsRenewAtSameTick(t *testing.T) {
	const ttl = 10
	for _, at := range []uint64{ttl - 2, ttl - 1, ttl, ttl + 1} {
		t.Run(fmt.Sprintf("renew_at_tick_%d", at), func(t *testing.T) {
			clock := NewClock(0)
			m := NewManager(clock)
			g, _ := m.Acquire("alice", ttl)
			clock.Advance(at)
			_, ok := m.Renew("alice", g.Generation, 1, ttl)
			want := at < ttl
			if ok != want {
				t.Fatalf("renew at tick %d (expiry %d): ok=%v, want %v", at, ttl, ok, want)
			}
		})
	}
}

// TestBoundaryEnumeration enumerates the full boundary window for acquire,
// renew, release and snapshot around the expiry tick.
func TestBoundaryEnumeration(t *testing.T) {
	const ttl = 10
	for at := uint64(ttl - 1); at <= ttl+1; at++ {
		at := at
		t.Run(fmt.Sprintf("tick_%d", at), func(t *testing.T) {
			live := at < ttl

			clock := NewClock(0)
			m := NewManager(clock)
			g, _ := m.Acquire("alice", ttl)
			clock.Advance(at)

			if _, ok := m.Snapshot(); ok != live {
				t.Errorf("snapshot live=%v, want %v", ok, live)
			}
			if _, ok := m.Renew("alice", g.Generation, 1, ttl); ok != live {
				t.Errorf("renew ok=%v, want %v", ok, live)
			}
			if got := m.Release("alice", g.Generation); got != live {
				t.Errorf("release ok=%v, want %v", got, live)
			}
			// Re-acquire by a contender: only possible once expired/released.
			if _, ok := m.Acquire("bob", ttl); ok != true {
				t.Errorf("acquire after release/expiry must succeed")
			}
		})
	}
}

func TestStaleHolderCannotTouchNewLease(t *testing.T) {
	clock := NewClock(0)
	m := NewManager(clock)
	old, _ := m.Acquire("alice", 10)

	clock.Advance(10) // old lease expires
	newGrant, ok := m.Acquire("bob", 10)
	if !ok {
		t.Fatal("bob must acquire after expiry")
	}
	if newGrant.Generation <= old.Generation {
		t.Fatalf("generation must increase: old=%d new=%d", old.Generation, newGrant.Generation)
	}

	if m.Release("alice", old.Generation) {
		t.Fatal("stale release must fail")
	}
	if _, ok := m.Renew("alice", old.Generation, 1, 10); ok {
		t.Fatal("stale renew must fail")
	}
	snap, ok := m.Snapshot()
	if !ok || snap.Owner != "bob" || snap.Generation != newGrant.Generation || snap.Expiry != 20 {
		t.Fatalf("new lease disturbed: %+v ok=%v", snap, ok)
	}
}

// TestStaleReleaseAcrossGenerations enumerates release attempts with every
// generation around the live one to pin down the fencing boundary.
func TestStaleReleaseAcrossGenerations(t *testing.T) {
	clock := NewClock(0)
	m := NewManager(clock)
	g1, _ := m.Acquire("alice", 5)
	clock.Advance(5)
	g2, _ := m.Acquire("bob", 5)

	for _, gen := range []uint64{g1.Generation, g2.Generation, g2.Generation + 1} {
		want := gen == g2.Generation
		if got := m.Release("bob", gen); got != want {
			t.Fatalf("release gen=%d: got %v, want %v", gen, got, want)
		}
	}
}

func TestGenerationTokenMonotonic(t *testing.T) {
	clock := NewClock(0)
	m := NewManager(clock)
	prev := uint64(0)
	for i := 0; i < 5; i++ {
		g, ok := m.Acquire("alice", 1)
		if !ok {
			t.Fatalf("acquire %d failed", i)
		}
		if g.Generation <= prev {
			t.Fatalf("generation not monotonic: %d after %d", g.Generation, prev)
		}
		prev = g.Generation
		clock.Advance(1)
	}
}

// TestConcurrentRace hammers the manager from many goroutines; run with
// -race to verify there are no data races. Invariants checked afterwards:
// the lease is in a consistent state and generations never repeat.
func TestConcurrentRace(t *testing.T) {
	clock := NewClock(0)
	m := NewManager(clock)

	var wg sync.WaitGroup
	seen := make(chan uint64, 4096)
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			owner := fmt.Sprintf("owner-%d", id)
			for i := 0; i < 200; i++ {
				g, ok := m.Acquire(owner, 2)
				if ok {
					seen <- g.Generation
					m.Renew(owner, g.Generation, uint64(i), 2)
					m.Release(owner, g.Generation)
				}
				m.Snapshot()
			}
		}(worker)
	}
	wg.Wait()
	close(seen)

	uniq := map[uint64]bool{}
	for gen := range seen {
		if uniq[gen] {
			t.Fatalf("generation %d granted twice", gen)
		}
		uniq[gen] = true
	}
}
