package lease

import (
	"errors"
	"fmt"
	"sync"
	"testing"
)

func mustAcquire(t *testing.T, m *Manager, key string, ttl uint64) Token {
	t.Helper()
	tok, err := m.Acquire(key, ttl)
	if err != nil {
		t.Fatalf("Acquire(%q, %d): %v", key, ttl, err)
	}
	return tok
}

func TestAcquireExclusiveAndExpiry(t *testing.T) {
	clock := NewClock()
	m := NewManager(clock)

	first := mustAcquire(t, m, "k", 10)
	if first.Generation != 1 || first.ExpiresAt != 10 {
		t.Fatalf("unexpected token: %+v", first)
	}
	if _, err := m.Acquire("k", 10); !errors.Is(err, ErrLeaseHeld) {
		t.Fatalf("second acquire while live: got %v, want ErrLeaseHeld", err)
	}

	clock.Advance(9) // now = 9, lease still live until tick 10
	if _, err := m.Acquire("k", 10); !errors.Is(err, ErrLeaseHeld) {
		t.Fatalf("acquire one tick before expiry: got %v, want ErrLeaseHeld", err)
	}

	clock.Advance(1) // now = 10 == expiresAt -> expired
	second := mustAcquire(t, m, "k", 5)
	if second.Generation != 2 || second.ExpiresAt != 15 {
		t.Fatalf("re-acquire after expiry: %+v, want generation 2 expiring at 15", second)
	}
}

func TestGenerationIsMonotonicPerKey(t *testing.T) {
	clock := NewClock()
	m := NewManager(clock)

	var prev uint64
	for i := 0; i < 5; i++ {
		tok := mustAcquire(t, m, "k", 1)
		if tok.Generation <= prev {
			t.Fatalf("generation not increasing: %d after %d", tok.Generation, prev)
		}
		prev = tok.Generation
		clock.Advance(1) // let it expire
	}
}

func TestRenewExtendsDeadline(t *testing.T) {
	clock := NewClock()
	m := NewManager(clock)
	tok := mustAcquire(t, m, "k", 10) // expires at 10

	clock.Advance(6) // now = 6
	r := m.Renew("k", tok.Generation, "req-1", 20)
	if !r.Granted || r.Err != nil {
		t.Fatalf("renew denied: %+v", r)
	}
	if r.ExpiresAt != 26 {
		t.Fatalf("renew deadline = %d, want 26 (now 6 + ttl 20)", r.ExpiresAt)
	}
	if got, ok := m.Inspect("k"); !ok || got.ExpiresAt != 26 {
		t.Fatalf("inspect after renew: %+v ok=%v, want deadline 26", got, ok)
	}
}

func TestDuplicateRenewReturnsOriginalAndNeverExtends(t *testing.T) {
	clock := NewClock()
	m := NewManager(clock)
	tok := mustAcquire(t, m, "k", 10) // expires at 10

	clock.Advance(6) // now = 6
	first := m.Renew("k", tok.Generation, "req-1", 20)
	if !first.Granted || first.ExpiresAt != 26 {
		t.Fatalf("first renew: %+v", first)
	}

	clock.Advance(15) // now = 21, lease still live until 26
	dup := m.Renew("k", tok.Generation, "req-1", 1000)
	if !dup.Granted || dup.ExpiresAt != first.ExpiresAt {
		t.Fatalf("duplicate renew = %+v, want original deadline %d", dup, first.ExpiresAt)
	}
	if got, _ := m.Inspect("k"); got.ExpiresAt != 26 {
		t.Fatalf("duplicate renew extended lease to %d, want unchanged 26", got.ExpiresAt)
	}

	// A different request ID is a new attempt and may extend.
	fresh := m.Renew("k", tok.Generation, "req-2", 5)
	if !fresh.Granted || fresh.ExpiresAt != 26 { // now 21 + 5
		t.Fatalf("distinct request ID renew: %+v, want deadline 26", fresh)
	}
}

func TestDuplicateRenewReplaysDenial(t *testing.T) {
	clock := NewClock()
	m := NewManager(clock)
	tok := mustAcquire(t, m, "k", 10)

	clock.Advance(10) // now = 10 == expiresAt -> expired
	denied := m.Renew("k", tok.Generation, "req-x", 10)
	if denied.Granted || !errors.Is(denied.Err, ErrLeaseExpired) {
		t.Fatalf("renew at expiry tick: %+v, want ErrLeaseExpired", denied)
	}

	// Even after a new lease exists, the recorded denial is replayed.
	mustAcquire(t, m, "k", 10)
	dup := m.Renew("k", tok.Generation, "req-x", 10)
	if dup.Granted || !errors.Is(dup.Err, ErrLeaseExpired) {
		t.Fatalf("duplicate denied renew: %+v, want replayed ErrLeaseExpired", dup)
	}
}

func TestLateDuplicateAfterReacquireDoesNotTouchNewLease(t *testing.T) {
	clock := NewClock()
	m := NewManager(clock)
	old := mustAcquire(t, m, "k", 10) // gen 1, expires at 10

	clock.Advance(6)
	granted := m.Renew("k", old.Generation, "req-1", 20) // deadline 26
	if !granted.Granted {
		t.Fatalf("renew: %+v", granted)
	}

	clock.Advance(20)                     // now = 26, old lease expired
	current := mustAcquire(t, m, "k", 50) // gen 2, expires at 76

	// A stale retry of the old renewal replays the original record and
	// must not extend (or otherwise affect) the new lease.
	dup := m.Renew("k", old.Generation, "req-1", 1000)
	if !dup.Granted || dup.ExpiresAt != granted.ExpiresAt {
		t.Fatalf("late duplicate = %+v, want replay of %+v", dup, granted)
	}
	if got, ok := m.Inspect("k"); !ok || got != current {
		t.Fatalf("new lease disturbed: %+v ok=%v, want %+v", got, ok, current)
	}
}

// TestRenewAroundExpiryTick enumerates the boundary race: a renewal
// landing strictly before the expiry tick wins; one landing on or after
// it loses to expiry.
func TestRenewAroundExpiryTick(t *testing.T) {
	for _, offset := range []int{-1, 0, 1} {
		t.Run(fmt.Sprintf("offset_%+d", offset), func(t *testing.T) {
			clock := NewClock()
			m := NewManager(clock)
			tok := mustAcquire(t, m, "k", 10) // expires at tick 10

			target := int(tok.ExpiresAt) + offset
			if target < 0 {
				target = 0
			}
			clock.Advance(uint64(target))

			r := m.Renew("k", tok.Generation, "req", 7)
			if offset < 0 {
				want := uint64(target) + 7
				if !r.Granted || r.ExpiresAt != want {
					t.Fatalf("renew before expiry: %+v, want granted until %d", r, want)
				}
			} else {
				if r.Granted || !errors.Is(r.Err, ErrLeaseExpired) {
					t.Fatalf("renew at/after expiry: %+v, want ErrLeaseExpired", r)
				}
				if _, ok := m.Inspect("k"); ok {
					t.Fatal("expired lease still reported live")
				}
			}
		})
	}
}

// TestAcquireAroundExpiryTick enumerates the same boundary for acquire:
// the key becomes acquirable exactly at the expiry tick.
func TestAcquireAroundExpiryTick(t *testing.T) {
	for _, offset := range []int{-1, 0, 1} {
		t.Run(fmt.Sprintf("offset_%+d", offset), func(t *testing.T) {
			clock := NewClock()
			m := NewManager(clock)
			first := mustAcquire(t, m, "k", 10) // expires at tick 10

			target := int(first.ExpiresAt) + offset
			if target < 0 {
				target = 0
			}
			clock.Advance(uint64(target))

			tok, err := m.Acquire("k", 5)
			if offset < 0 {
				if !errors.Is(err, ErrLeaseHeld) {
					t.Fatalf("acquire before expiry: %v, want ErrLeaseHeld", err)
				}
			} else {
				if err != nil {
					t.Fatalf("acquire at/after expiry: %v", err)
				}
				if tok.Generation != first.Generation+1 {
					t.Fatalf("generation = %d, want %d", tok.Generation, first.Generation+1)
				}
			}
		})
	}
}

func TestReleaseStaleGenerationCannotTouchNewLease(t *testing.T) {
	clock := NewClock()
	m := NewManager(clock)
	old := mustAcquire(t, m, "k", 10)

	clock.Advance(10) // old lease expires
	current := mustAcquire(t, m, "k", 10)

	// The evicted holder finally processes its release: it must fail
	// and leave the new lease alone.
	if err := m.Release("k", old.Generation); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale release: %v, want ErrStaleGeneration", err)
	}
	if got, ok := m.Inspect("k"); !ok || got != current {
		t.Fatalf("new lease after stale release: %+v ok=%v, want %+v", got, ok, current)
	}

	if err := m.Release("k", current.Generation); err != nil {
		t.Fatalf("current release: %v", err)
	}
	if _, ok := m.Inspect("k"); ok {
		t.Fatal("lease still live after current holder released")
	}
	// Releasing twice is stale as well.
	if err := m.Release("k", current.Generation); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("double release: %v, want ErrStaleGeneration", err)
	}
}

func TestRenewWithStaleGenerationDenied(t *testing.T) {
	clock := NewClock()
	m := NewManager(clock)
	old := mustAcquire(t, m, "k", 10)

	clock.Advance(10)
	current := mustAcquire(t, m, "k", 10)

	r := m.Renew("k", old.Generation, "req-stale", 10)
	if r.Granted || !errors.Is(r.Err, ErrStaleGeneration) {
		t.Fatalf("stale renew: %+v, want ErrStaleGeneration", r)
	}
	if got, _ := m.Inspect("k"); got != current {
		t.Fatalf("stale renew touched lease: %+v, want %+v", got, current)
	}
}

func TestConcurrentContentionSingleWinner(t *testing.T) {
	clock := NewClock()
	m := NewManager(clock)

	const contenders = 32
	var wg sync.WaitGroup
	wins := make(chan Token, contenders)
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if tok, err := m.Acquire("k", 100); err == nil {
				wins <- tok
			}
		}()
	}
	wg.Wait()
	close(wins)

	var tokens []Token
	for tok := range wins {
		tokens = append(tokens, tok)
	}
	if len(tokens) != 1 {
		t.Fatalf("%d goroutines won the lease, want exactly 1", len(tokens))
	}
	if got, ok := m.Inspect("k"); !ok || got != tokens[0] {
		t.Fatalf("inspect = %+v ok=%v, want winner %+v", got, ok, tokens[0])
	}
}

func TestConcurrentRenewStormIsIdempotent(t *testing.T) {
	clock := NewClock()
	m := NewManager(clock)
	tok := mustAcquire(t, m, "k", 1000)

	const retries = 64
	results := make(chan Renewal, retries)
	var wg sync.WaitGroup
	for i := 0; i < retries; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- m.Renew("k", tok.Generation, "shared-req", 500)
		}()
	}
	wg.Wait()
	close(results)

	for r := range results {
		if !r.Granted || r.ExpiresAt != 500 {
			t.Fatalf("inconsistent duplicate outcome: %+v, want deadline 500", r)
		}
	}
	if got, _ := m.Inspect("k"); got.ExpiresAt != 500 {
		t.Fatalf("deadline = %d, want 500 (extended exactly once)", got.ExpiresAt)
	}
}

func TestZeroTTLRejected(t *testing.T) {
	m := NewManager(NewClock())
	if _, err := m.Acquire("k", 0); !errors.Is(err, ErrZeroTTL) {
		t.Fatalf("acquire ttl=0: %v, want ErrZeroTTL", err)
	}
	mustAcquire(t, m, "k", 10)
	if r := m.Renew("k", 1, "req", 0); r.Granted || !errors.Is(r.Err, ErrZeroTTL) {
		t.Fatalf("renew ttl=0: %+v, want ErrZeroTTL", r)
	}
}
