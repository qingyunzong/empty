package authreplay

import (
	"fmt"
	"math"
	"math/rand/v2"
	"sync"
	"testing"
)

func TestBadWidth(t *testing.T) {
	for _, w := range []uint{0, 65, 1000} {
		if _, err := NewAuthenticator(w); err == nil {
			t.Fatalf("width %d: expected error", w)
		}
	}
}

func TestInOrderAccept(t *testing.T) {
	a := MustAuthenticator(8)
	for i := uint64(1); i <= 20; i++ {
		if !a.Verify("c", i, true) {
			t.Fatalf("counter %d should be accepted", i)
		}
	}
}

func TestOutOfOrderWithinWindow(t *testing.T) {
	a := MustAuthenticator(8)
	// Establish highest = 10.
	if !a.Verify("c", 10, true) {
		t.Fatal("counter 10 should be accepted")
	}
	// Counters 3..9 arrive late but inside the window (diff 1..7).
	for _, n := range []uint64{7, 3, 9, 4} {
		if !a.Verify("c", n, true) {
			t.Fatalf("counter %d should be accepted inside window", n)
		}
	}
	// Counter 2 is diff 8 >= width 8: too old.
	if a.Verify("c", 2, true) {
		t.Fatal("counter 2 should be rejected (outside window)")
	}
}

func TestDuplicateRejected(t *testing.T) {
	a := MustAuthenticator(8)
	if !a.Verify("c", 5, true) {
		t.Fatal("first accept")
	}
	if a.Verify("c", 5, true) {
		t.Fatal("duplicate must be rejected")
	}
	if !a.Verify("c", 6, true) {
		t.Fatal("advance")
	}
	if a.Verify("c", 5, true) {
		t.Fatal("duplicate after advance must be rejected")
	}
}

func TestJumpCleWeightClearsOldBits(t *testing.T) {
	a := MustAuthenticator(4)
	for _, n := range []uint64{1, 2, 3, 4} {
		if !a.Verify("c", n, true) {
			t.Fatalf("counter %d should be accepted", n)
		}
	}
	// Jump far ahead: all old bits must be cleaned.
	if !a.Verify("c", 100, true) {
		t.Fatal("jump should be accepted")
	}
	// Old counters are now outside the window.
	for _, n := range []uint64{1, 2, 3, 4, 95, 96} {
		if a.Verify("c", n, true) {
			t.Fatalf("stale counter %d must be rejected after jump", n)
		}
	}
	// But counters within W of the new highest still work.
	if !a.Verify("c", 99, true) {
		t.Fatal("counter 99 should be accepted")
	}
}

func TestBadSignatureDoesNotAdvanceWindow(t *testing.T) {
	a := MustAuthenticator(4)
	if !a.Verify("c", 10, true) {
		t.Fatal("seed")
	}
	// Forged request with a huge counter must not move the window.
	if a.Verify("c", 1_000_000, false) {
		t.Fatal("bad signature must be rejected")
	}
	// A counter that would be stale if the window had advanced is
	// still valid, proving the window never moved.
	if !a.Verify("c", 9, true) {
		t.Fatal("window must not advance on bad signature")
	}
	if h, ok := a.Highest("c"); !ok || h != 10 {
		t.Fatalf("highest = %d, %v; want 10, true", h, ok)
	}
	// Bad signature on a duplicate of the current counter also fails.
	if a.Verify("c", 10, false) {
		t.Fatal("bad signature must be rejected")
	}
}

func TestClientsAreIndependent(t *testing.T) {
	a := MustAuthenticator(4)
	if !a.Verify("alice", 100, true) {
		t.Fatal("alice seed")
	}
	if !a.Verify("bob", 1, true) {
		t.Fatal("bob has his own window")
	}
	if a.Verify("bob", 100, true) == false {
		t.Log("bob jumping to 100 is fine, independent of alice")
	}
}

func TestConcurrentIdenticalRequestsSucceedOnce(t *testing.T) {
	a := MustAuthenticator(64)
	const goroutines = 64
	var wg sync.WaitGroup
	var mu sync.Mutex
	successes := 0
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if a.Verify("c", 42, true) {
				mu.Lock()
				successes++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if successes != 1 {
		t.Fatalf("got %d successes, want exactly 1", successes)
	}
}

func TestConcurrentMixedLoad(t *testing.T) {
	a := MustAuthenticator(32)
	const goroutines = 32
	const per = 500
	var wg sync.WaitGroup
	// Each goroutine uses its own client with in-order counters, so
	// every request with a valid signature must succeed exactly once.
	results := make([][]bool, goroutines)
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			client := fmt.Sprintf("g%d", g)
			base := uint64(g) * per
			out := make([]bool, per)
			for i := 0; i < per; i++ {
				out[i] = a.Verify(client, base+uint64(i)+1, true)
			}
			results[g] = out
		}(g)
	}
	wg.Wait()
	for g, out := range results {
		for i, ok := range out {
			if !ok {
				t.Fatalf("goroutine %d request %d rejected", g, i)
			}
		}
	}
}

// model is a set-based reference implementation used to cross-check
// the bitmap window.
type model struct {
	width    uint64
	started  bool
	highest  uint64
	accepted map[uint64]struct{}
}

func newModel(width uint64) *model {
	return &model{width: width, accepted: make(map[uint64]struct{})}
}

func (m *model) verify(counter uint64, signatureOK bool) bool {
	if !signatureOK {
		return false
	}
	if !m.started {
		m.started = true
		m.highest = counter
		m.accepted[counter] = struct{}{}
		return true
	}
	if _, dup := m.accepted[counter]; dup {
		return false
	}
	// Reject counters at or below the lower window edge. Computed
	// without underflow: counter <= highest - width  <=>
	// counter + width <= highest (no overflow: counter <= highest).
	if counter <= m.highest && m.highest-counter >= m.width {
		return false
	}
	if counter > m.highest {
		m.highest = counter
	}
	m.accepted[counter] = struct{}{}
	return true
}

// counterPools returns counter values exercising big-integer
// boundaries: near zero, mid-range, and near math.MaxUint64.
func counterPools(rng *rand.Rand) []uint64 {
	pools := []uint64{0, 1, 2, 3}
	for i := 0; i < 8; i++ {
		pools = append(pools, rng.Uint64N(1000))
	}
	top := uint64(math.MaxUint64)
	for i := uint64(0); i < 8; i++ {
		pools = append(pools, top-i)
	}
	// Random values clustered near the top to force jumps and
	// in-window duplicates at the boundary.
	for i := 0; i < 8; i++ {
		pools = append(pools, top-rng.Uint64N(64))
	}
	return pools
}

func TestAgainstSetModel(t *testing.T) {
	for _, width := range []uint{1, 2, 3, 8, 33, 64} {
		t.Run(widthName(width), func(t *testing.T) {
			rng := rand.New(rand.NewPCG(uint64(width), 0x5eed))
			a := MustAuthenticator(width)
			pools := counterPools(rng)
			clients := []string{"a", "b", "c"}
			models := map[string]*model{"a": newModel(uint64(width)), "b": newModel(uint64(width)), "c": newModel(uint64(width))}
			for step := 0; step < 20000; step++ {
				cl := clients[rng.IntN(len(clients))]
				counter := pools[rng.IntN(len(pools))]
				sigOK := rng.IntN(4) != 0 // 25% bad signatures
				got := a.Verify(cl, counter, sigOK)
				want := models[cl].verify(counter, sigOK)
				if got != want {
					t.Fatalf("step %d: Verify(%q, %d, %v) = %v, model says %v",
						step, cl, counter, sigOK, got, want)
				}
			}
		})
	}
}

func widthName(w uint) string {
	return fmt.Sprintf("W=%d", w)
}

func TestMaxUint64Boundary(t *testing.T) {
	a := MustAuthenticator(8)
	top := uint64(math.MaxUint64)
	// Establish the window at the very top of the counter space.
	if !a.Verify("c", top, true) {
		t.Fatal("MaxUint64 should be accepted")
	}
	if a.Verify("c", top, true) {
		t.Fatal("duplicate MaxUint64 must be rejected")
	}
	// In-window predecessors still accepted out of order.
	for _, n := range []uint64{top - 3, top - 1, top - 7} {
		if !a.Verify("c", n, true) {
			t.Fatalf("counter %d should be accepted", n)
		}
	}
	if a.Verify("c", top-3, true) {
		t.Fatal("duplicate near boundary must be rejected")
	}
	// Just outside the window (diff = 8).
	if a.Verify("c", top-8, true) {
		t.Fatal("counter below window edge must be rejected")
	}
	// Bad signature at the boundary must not disturb anything.
	if a.Verify("c", top-2, false) {
		t.Fatal("bad signature must be rejected")
	}
	if !a.Verify("c", top-2, true) {
		t.Fatal("counter top-2 must still be acceptable")
	}
}
