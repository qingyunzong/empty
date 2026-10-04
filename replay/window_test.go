package replay

import (
	"errors"
	"fmt"
	"math/big"
	"math/rand"
	"sync"
	"testing"
)

// setModel is the reference implementation: an explicit set of accepted
// counters plus the highest accepted counter. A counter is acceptable
// iff it has never been accepted and is not older than width counters
// below the current highest.
type setModel struct {
	width   uint64
	highest *big.Int
	seen    map[string]struct{}
}

func newSetModel(width uint64) *setModel {
	return &setModel{width: width, seen: make(map[string]struct{})}
}

func (m *setModel) check(counter *big.Int) bool {
	if m.highest == nil {
		m.seen[counter.String()] = struct{}{}
		m.highest = new(big.Int).Set(counter)
		return true
	}
	if diff := new(big.Int).Sub(m.highest, counter); diff.Sign() > 0 {
		if !diff.IsUint64() || diff.Uint64() >= m.width {
			return false // fell off the back of the window
		}
	}
	key := counter.String()
	if _, dup := m.seen[key]; dup {
		return false
	}
	m.seen[key] = struct{}{}
	if counter.Cmp(m.highest) > 0 {
		m.highest.Set(counter)
	}
	return true
}

func pow2(n uint) *big.Int { return new(big.Int).Lsh(big.NewInt(1), n) }

// TestAgainstSetModel drives the Window and the set model with the same
// randomized counter sequences — including duplicates, in-window
// reordering, and jumps across 2^64 and 2^128 — and requires identical
// accept/reject decisions at every step.
func TestAgainstSetModel(t *testing.T) {
	widths := []uint64{1, 8, 64, 4096}
	for _, width := range widths {
		t.Run(fmt.Sprintf("W=%d", width), func(t *testing.T) {
			rng := rand.New(rand.NewSource(int64(width)*7919 + 1))
			window := NewWindow(width)
			model := newSetModel(width)
			cursor := new(big.Int)
			for step := 0; step < 20000; step++ {
				var counter *big.Int
				switch rng.Intn(6) {
				case 0: // next sequential counter
					counter = new(big.Int).Add(cursor, big.NewInt(1))
				case 1: // recent value: often a duplicate or in-window straggler
					back := rng.Int63n(int64(width) + 2)
					counter = new(big.Int).Sub(cursor, big.NewInt(back))
				case 2: // small forward skip
					counter = new(big.Int).Add(cursor, big.NewInt(rng.Int63n(int64(width)+3)))
				case 3: // jump beyond the window, sometimes across 2^64/2^128
					jump := new(big.Int).Add(pow2(64), big.NewInt(rng.Int63n(1<<20)))
					if rng.Intn(4) == 0 {
						jump = pow2(128)
					}
					counter = new(big.Int).Add(cursor, jump)
				case 4: // far past: always too old once highest is larger
					counter = new(big.Int).Sub(cursor, big.NewInt(rng.Int63n(1<<16)))
				default: // arbitrary big value around 2^64..2^130
					counter = new(big.Int).Add(pow2(uint(64+rng.Intn(67))), big.NewInt(rng.Int63()))
				}
				if counter.Sign() < 0 {
					counter.SetInt64(0)
				}
				got := window.CheckAndMark(counter)
				want := model.check(counter)
				if got != want {
					t.Fatalf("step %d: counter=%s window=%v model=%v", step, counter, got, want)
				}
				if counter.Cmp(cursor) > 0 {
					cursor.Set(counter)
				}
			}
			if got, want := window.Highest().String(), model.highest.String(); got != want {
				t.Fatalf("highest mismatch: window=%s model=%s", got, want)
			}
		})
	}
}

// TestBigIntBoundaries exercises counters straddling the word-size
// boundaries 2^64 and 2^128 with a window much smaller than the jumps.
func TestBigIntBoundaries(t *testing.T) {
	w := NewWindow(64)
	seq := []struct {
		counter *big.Int
		want    bool
	}{
		{new(big.Int).Sub(pow2(64), big.NewInt(1)), true},  // 2^64-1
		{new(big.Int).Sub(pow2(64), big.NewInt(2)), true},  // one back, in window
		{new(big.Int).Sub(pow2(64), big.NewInt(2)), false}, // duplicate
		{pow2(64), true},  // 2^64
		{pow2(128), true}, // jump clears all old bits
		{new(big.Int).Sub(pow2(128), big.NewInt(63)), true},  // edge of window
		{new(big.Int).Sub(pow2(128), big.NewInt(64)), false}, // just outside
		{new(big.Int).Sub(pow2(64), big.NewInt(1)), false},   // ancient history
		{new(big.Int).Add(pow2(128), big.NewInt(1)), true},
		{pow2(128), false}, // duplicate of the jump target
		{new(big.Int).Sub(pow2(128), big.NewInt(1)), true}, // backfill an unseen slot
		{new(big.Int).Sub(pow2(128), big.NewInt(1)), false},
	}
	for i, tc := range seq {
		if got := w.CheckAndMark(tc.counter); got != tc.want {
			t.Errorf("step %d counter=%s: got %v, want %v", i, tc.counter, got, tc.want)
		}
	}
	if got := w.Highest().String(); got != "340282366920938463463374607431768211457" {
		t.Errorf("highest = %s, want 2^128+1", got)
	}
}

// TestConcurrentIdenticalRequests fires the same request from many
// goroutines and requires exactly one success.
func TestConcurrentIdenticalRequests(t *testing.T) {
	reg := NewRegistry(64, nil)
	const goroutines = 128
	var wg sync.WaitGroup
	var mu sync.Mutex
	successes := 0
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := reg.Authenticate("client-a", big.NewInt(42), []byte("m"), []byte("s"))
			if err != nil {
				t.Error(err)
				return
			}
			if ok {
				mu.Lock()
				successes++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if successes != 1 {
		t.Fatalf("successes = %d, want exactly 1", successes)
	}
}

// TestConcurrentMixedRequests runs a concurrent burst of distinct and
// duplicate counters, then asserts that a second identical burst is
// rejected wholesale — everything that could be accepted was recorded
// exactly once.
func TestConcurrentMixedRequests(t *testing.T) {
	reg := NewRegistry(128, nil)
	burst := func() (accepted []int64) {
		var wg sync.WaitGroup
		var mu sync.Mutex
		for i := 0; i < 256; i++ {
			// 100 distinct counters, all within the 128-wide window of
			// one another, so every first sighting is acceptable
			// regardless of goroutine interleaving.
			counter := int64(i % 100)
			wg.Add(1)
			go func() {
				defer wg.Done()
				ok, err := reg.Authenticate("client-b", big.NewInt(counter), nil, nil)
				if err != nil {
					t.Error(err)
					return
				}
				if ok {
					mu.Lock()
					accepted = append(accepted, counter)
					mu.Unlock()
				}
			}()
		}
		wg.Wait()
		return accepted
	}
	first := burst()
	seen := make(map[int64]bool)
	for _, c := range first {
		if seen[c] {
			t.Fatalf("counter %d accepted twice in one burst", c)
		}
		seen[c] = true
	}
	if len(first) != 100 {
		t.Fatalf("first burst accepted %d counters, want 100", len(first))
	}
	if second := burst(); len(second) != 0 {
		t.Fatalf("replay burst accepted %d counters, want 0", len(second))
	}
}

// TestBadSignatureDoesNotAdvanceWindow verifies that a failed signature
// leaves the window bit-for-bit untouched: the forged counter is not
// recorded and the window does not slide forward.
func TestBadSignatureDoesNotAdvanceWindow(t *testing.T) {
	verify := func(_ string, _ *big.Int, _, sig []byte) bool {
		return string(sig) == "good"
	}
	reg := NewRegistry(8, verify)

	ok, err := reg.Authenticate("c", big.NewInt(10), nil, []byte("good"))
	if err != nil || !ok {
		t.Fatalf("baseline accept failed: ok=%v err=%v", ok, err)
	}
	// Forged request with a far-future counter must not advance anything.
	ok, err = reg.Authenticate("c", big.NewInt(1000), nil, []byte("evil"))
	if !errors.Is(err, ErrBadSignature) {
		t.Fatalf("err = %v, want ErrBadSignature", err)
	}
	if ok {
		t.Fatal("forged request reported acceptance")
	}
	if h := reg.Highest("c"); h.Cmp(big.NewInt(10)) != 0 {
		t.Fatalf("highest moved to %s after bad signature", h)
	}
	// The forged counter must not be marked: a properly signed request
	// with the same counter is still a first sighting.
	ok, err = reg.Authenticate("c", big.NewInt(1000), nil, []byte("good"))
	if err != nil || !ok {
		t.Fatalf("forged counter was recorded anyway: ok=%v err=%v", ok, err)
	}
	// And an in-window straggler from before the jump is still accepted.
	ok, err = reg.Authenticate("c", big.NewInt(995), nil, []byte("good"))
	if err != nil || !ok {
		t.Fatalf("in-window straggler rejected: ok=%v err=%v", ok, err)
	}
}

// TestPerClientIsolation ensures windows are independent per client.
func TestPerClientIsolation(t *testing.T) {
	reg := NewRegistry(4, nil)
	if ok, _ := reg.Authenticate("a", big.NewInt(5), nil, nil); !ok {
		t.Fatal("client a first request rejected")
	}
	if ok, _ := reg.Authenticate("b", big.NewInt(5), nil, nil); !ok {
		t.Fatal("client b same counter rejected")
	}
	if ok, _ := reg.Authenticate("a", big.NewInt(5), nil, nil); ok {
		t.Fatal("client a duplicate accepted")
	}
}

func TestInvalidCounters(t *testing.T) {
	w := NewWindow(8)
	if w.CheckAndMark(nil) {
		t.Error("nil counter accepted")
	}
	if w.CheckAndMark(big.NewInt(-1)) {
		t.Error("negative counter accepted")
	}
	reg := NewRegistry(8, nil)
	if _, err := reg.Authenticate("c", big.NewInt(-3), nil, nil); err == nil {
		t.Error("negative counter: expected error")
	}
	if h := reg.Highest("nobody"); h != nil {
		t.Errorf("unknown client highest = %v, want nil", h)
	}
}
