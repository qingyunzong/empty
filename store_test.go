package tokenbucket

import (
	"fmt"
	"math/rand"
	"path/filepath"
	"testing"
)

func mustStore(t *testing.T, path string, cfg Config, opts ...Option) *Store {
	t.Helper()
	s, err := Open(path, cfg, opts...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func mustAllow(t *testing.T, s *Store, now int64, id string, cost int64) bool {
	t.Helper()
	ok, err := s.Allow(now, id, cost)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

func testCfg() Config { return Config{Capacity: 4, RateNum: 1, RateDen: 2} }

func TestDuplicateRequestIDReturnsOriginalDecision(t *testing.T) {
	s := mustStore(t, filepath.Join(t.TempDir(), "log.jsonl"), testCfg())
	if !mustAllow(t, s, 0, "a", 3) {
		t.Fatal("first request should be allowed")
	}
	tokens, _, _ := s.State()
	if tokens != 1 {
		t.Fatalf("tokens = %d, want 1", tokens)
	}
	// Duplicate at a later time: same decision, no extra charge, and
	// no refill is applied by the lookup itself.
	if !mustAllow(t, s, 1000, "a", 3) {
		t.Fatal("duplicate must replay the original decision")
	}
	tokens, _, _ = s.State()
	if tokens != 1 {
		t.Fatalf("duplicate charged tokens: %d", tokens)
	}
	// A denied decision is replayed too.
	if mustAllow(t, s, 0, "b", 99) {
		t.Fatal("should be denied")
	}
	if mustAllow(t, s, 1000, "b", 99) {
		t.Fatal("denied decision must be replayed")
	}
}

func TestRestartDoesNotDoubleCharge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log.jsonl")
	s := mustStore(t, path, testCfg())
	mustAllow(t, s, 0, "a", 2)
	mustAllow(t, s, 1, "b", 2)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s2 := mustStore(t, path, testCfg())
	tokens, rem, last := s2.State()
	if tokens != 0 || rem != 1 || last != 1 {
		t.Fatalf("restored state = (%d, %d, %d), want (0, 1, 1)", tokens, rem, last)
	}
	// Replaying old IDs must not charge again after restart.
	if !mustAllow(t, s2, 500, "a", 2) || !mustAllow(t, s2, 500, "b", 2) {
		t.Fatal("decisions must survive restart")
	}
	tokens, _, _ = s2.State()
	if tokens != 0 {
		t.Fatalf("restart double-charged: tokens = %d", tokens)
	}
	// New IDs still work and see refills from the restored clock.
	if !mustAllow(t, s2, 500, "c", 1) {
		t.Fatal("new request after restart should be allowed")
	}
}

func TestTruncatePreservesIdempotencyWindow(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log.jsonl")
	s := mustStore(t, path, testCfg())
	for i := 0; i < 10; i++ {
		mustAllow(t, s, int64(i), fmt.Sprintf("r%d", i), 0)
	}
	mustAllow(t, s, 10, "spend", 2)
	if err := s.Truncate(3); err != nil {
		t.Fatal(err)
	}
	if n := s.LogLen(); n != 3 {
		t.Fatalf("log length = %d, want 3", n)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	s2 := mustStore(t, path, testCfg())
	// State is exactly preserved by the kept records.
	tokens, rem, last := s2.State()
	if tokens != 2 || rem != 0 || last != 10 {
		t.Fatalf("state after truncate+restart = (%d, %d, %d), want (2, 0, 10)", tokens, rem, last)
	}
	// The 3 kept IDs (r8, r9, spend) remain idempotent.
	for _, id := range []string{"r8", "r9", "spend"} {
		mustAllow(t, s2, 100, id, 0)
	}
	tokens, _, _ = s2.State()
	if tokens != 2 {
		t.Fatalf("kept window ID re-charged: tokens = %d", tokens)
	}
	// An evicted ID is outside the window: treated as new and charged.
	if !mustAllow(t, s2, 100, "r0", 1) {
		t.Fatal("evicted ID should be processed as new")
	}
	tokens, _, _ = s2.State()
	if tokens != 3 { // refilled to capacity 4 at t=100, minus 1
		t.Fatalf("tokens = %d, want 3", tokens)
	}
}

func TestAutoTruncate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "log.jsonl")
	s := mustStore(t, path, testCfg(), WithAutoTruncate(20, 5))
	for i := 0; i < 25; i++ {
		mustAllow(t, s, int64(i), fmt.Sprintf("r%d", i), 0)
	}
	// At 21 records the log is truncated to the window of 5, then 4
	// more records accumulate.
	if n := s.LogLen(); n != 9 {
		t.Fatalf("log length = %d, want 9", n)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s2 := mustStore(t, path, testCfg())
	// Only the last 5 IDs are idempotent.
	if !mustAllow(t, s2, 1000, "r24", 0) {
		t.Fatal("recent ID should replay")
	}
	tokens, _, _ := s2.State()
	mustAllow(t, s2, 1000, "r0", 1) // evicted: charged as new
	tokens2, _, _ := s2.State()
	if tokens2 >= tokens+1 {
		t.Fatal("evicted ID was not charged")
	}
}

// modelStore mirrors Store semantics with a rational bucket and an
// explicit idempotency window, for randomized end-to-end checking.
type modelStore struct {
	m     *ratModel
	dedup map[string]bool
	order []string
}

func (m *modelStore) allow(now int64, id string, cost int64) bool {
	if d, ok := m.dedup[id]; ok {
		return d
	}
	d := m.m.allow(now, cost)
	m.dedup[id] = d
	m.order = append(m.order, id)
	return d
}

func (m *modelStore) truncate(keep int) {
	if keep > len(m.order) {
		keep = len(m.order)
	}
	kept := append([]string(nil), m.order[len(m.order)-keep:]...)
	nd := make(map[string]bool, len(kept))
	for _, id := range kept {
		nd[id] = m.dedup[id]
	}
	m.dedup = nd
	m.order = kept
}

// TestStoreEndToEndModel runs random operations — requests (with
// duplicates and backwards clock jumps), restarts, truncations — and
// checks every decision against the model.
func TestStoreEndToEndModel(t *testing.T) {
	for seed := int64(0); seed < 25; seed++ {
		rng := rand.New(rand.NewSource(seed))
		cfg := Config{
			Capacity: int64(1 + rng.Intn(10)),
			RateNum:  int64(rng.Intn(5)),
			RateDen:  int64(1 + rng.Intn(5)),
		}
		dir := t.TempDir()
		path := filepath.Join(dir, "log.jsonl")

		m := &modelStore{m: newRatModel(cfg), dedup: map[string]bool{}}
		s, err := Open(path, cfg)
		if err != nil {
			t.Fatal(err)
		}
		now := int64(0)
		for step := 0; step < 300; step++ {
			switch rng.Intn(10) {
			case 0: // restart
				if err := s.Close(); err != nil {
					t.Fatal(err)
				}
				s, err = Open(path, cfg)
				if err != nil {
					t.Fatalf("seed %d step %d: reopen: %v", seed, step, err)
				}
			case 1: // truncate to a random window
				keep := rng.Intn(8)
				if err := s.Truncate(keep); err != nil {
					t.Fatalf("seed %d step %d: truncate: %v", seed, step, err)
				}
				m.truncate(keep)
			default: // request
				if rng.Intn(5) == 0 {
					now -= int64(rng.Intn(8))
				} else {
					now += int64(rng.Intn(4))
				}
				id := fmt.Sprintf("id-%d", rng.Intn(12)) // small pool: duplicates likely
				cost := int64(rng.Intn(6))
				got, err := s.Allow(now, id, cost)
				if err != nil {
					t.Fatal(err)
				}
				want := m.allow(now, id, cost)
				if got != want {
					t.Fatalf("seed %d step %d: decision %v, model %v (id %s, now %d, cost %d)",
						seed, step, got, want, id, now, cost)
				}
			}
			st, sr, sl := s.State()
			mt, mr := m.m.floorAndFrac()
			if st != mt || sr != mr || sl != m.m.last {
				t.Fatalf("seed %d step %d: state (%d,%d,%d), model (%d,%d,%d)",
					seed, step, st, sr, sl, mt, mr, m.m.last)
			}
		}
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
	}
}
