package dedup

import (
	"crypto/sha256"
	"fmt"
	"math/rand"
	"path/filepath"
	"testing"
)

func ev(key string, t int64, payload string) Event {
	return Event{Key: key, EventTime: t, Payload: []byte(payload)}
}

func TestBasicVerdicts(t *testing.T) {
	s := New(10)

	if got := s.Ingest(ev("a", 100, "p1")); got != Accepted {
		t.Fatalf("first ingest = %v, want Accepted", got)
	}
	if got := s.Ingest(ev("a", 100, "p1")); got != Duplicate {
		t.Fatalf("same key+payload = %v, want Duplicate", got)
	}
	if got := s.Ingest(ev("a", 100, "p2")); got != Conflict {
		t.Fatalf("same key, different payload = %v, want Conflict", got)
	}
	// Conflict must not overwrite the retained payload.
	if got := s.Ingest(ev("a", 100, "p1")); got != Duplicate {
		t.Fatalf("after conflict, original payload = %v, want Duplicate", got)
	}
}

func TestLateRejectedNotTreatedAsNew(t *testing.T) {
	s := New(10)

	s.Ingest(ev("a", 100, "p1"))
	s.AdvanceWatermark(200) // cutoff = 190, key "a" evicted
	if n := s.Len(); n != 0 {
		t.Fatalf("Len after eviction = %d, want 0", n)
	}

	// The evicted key re-arrives: it must be rejected as late, not
	// re-admitted as a new event.
	if got := s.Ingest(ev("a", 100, "p1")); got != RejectedLate {
		t.Fatalf("evicted key re-arrival = %v, want RejectedLate", got)
	}
	if n := s.Len(); n != 0 {
		t.Fatalf("late event must not be stored, Len = %d", n)
	}
	// A brand-new key that is also late is rejected too.
	if got := s.Ingest(ev("zz", 150, "p9")); got != RejectedLate {
		t.Fatalf("new late key = %v, want RejectedLate", got)
	}
	// In-window arrivals still work.
	if got := s.Ingest(ev("b", 195, "p3")); got != Accepted {
		t.Fatalf("in-window new key = %v, want Accepted", got)
	}
}

func TestWatermarkMonotonicAndEviction(t *testing.T) {
	s := New(10)
	s.Ingest(ev("a", 50, "p"))
	s.Ingest(ev("b", 60, "p"))
	s.Ingest(ev("c", 70, "p")) // watermark = 70, cutoff = 60: "a" and "b" evicted

	if n := s.Len(); n != 1 {
		t.Fatalf("Len = %d, want 1 (a,b evicted by ingest-driven watermark)", n)
	}
	if wm, ok := s.Watermark(); !ok || wm != 70 {
		t.Fatalf("Watermark = %d,%v, want 70,true", wm, ok)
	}

	s.AdvanceWatermark(30) // backwards: ignored
	if wm, _ := s.Watermark(); wm != 70 {
		t.Fatalf("Watermark moved backwards to %d", wm)
	}

	s.AdvanceWatermark(81) // cutoff = 71: everything evicted
	if n := s.Len(); n != 0 {
		t.Fatalf("Len = %d, want 0", n)
	}
}

func TestRestartPreservesWatermarkAndKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snap.json")

	s1, err := Open(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	s1.Ingest(ev("a", 100, "p1"))
	s1.Ingest(ev("b", 105, "p2"))
	s1.AdvanceWatermark(112) // cutoff = 102: "a" evicted, "b" retained
	if err := s1.Save(); err != nil {
		t.Fatal(err)
	}

	s2, err := Open(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	if wm, ok := s2.Watermark(); !ok || wm != 112 {
		t.Fatalf("restored Watermark = %d,%v, want 112,true", wm, ok)
	}
	if n := s2.Len(); n != 1 {
		t.Fatalf("restored Len = %d, want 1", n)
	}
	if got := s2.Ingest(ev("b", 105, "p2")); got != Duplicate {
		t.Fatalf("restored key = %v, want Duplicate", got)
	}
	if got := s2.Ingest(ev("b", 105, "changed")); got != Conflict {
		t.Fatalf("restored key, new payload = %v, want Conflict", got)
	}
	if got := s2.Ingest(ev("a", 100, "p1")); got != RejectedLate {
		t.Fatalf("evicted-before-restart key = %v, want RejectedLate", got)
	}

	if _, err := Open(path, 99); err == nil {
		t.Fatal("Open with mismatched window must fail")
	}
}

// model is the full-history reference: it never forgets an accepted key, so
// it computes the ground-truth verdict for every event under the same
// watermark rules.
type model struct {
	window       int64
	watermark    int64
	hasWatermark bool
	seen         map[string][32]byte
}

func newModel(window int64) *model {
	return &model{window: window, seen: make(map[string][32]byte)}
}

func (m *model) advance(t int64) {
	if m.hasWatermark && t <= m.watermark {
		return
	}
	m.watermark = t
	m.hasWatermark = true
}

func (m *model) ingest(e Event) Verdict {
	if m.hasWatermark && e.EventTime <= m.watermark-m.window {
		return RejectedLate
	}
	m.advance(e.EventTime)
	h := sha256.Sum256(e.Payload)
	if prev, ok := m.seen[e.Key]; ok {
		if prev == h {
			return Duplicate
		}
		return Conflict
	}
	m.seen[e.Key] = h
	return Accepted
}

// TestRandomizedReplayAgainstFullHistory feeds an out-of-order replay of a
// generated history (with duplicates and payload mutations) to both the
// bounded store and the full-history model, restarting the store from its
// snapshot midway. Every verdict must match the model.
//
// Reconciliation argument: the watermark is monotonic, so the eviction
// cutoff is monotonic. A key is only evicted once its event time is at or
// below the cutoff; because each key carries a fixed event time, any later
// re-arrival of an evicted key is necessarily late and is rejected before
// the key table is consulted — exactly what the full-history model does.
// Hence bounded retention and full history agree on every verdict.
func TestRandomizedReplayAgainstFullHistory(t *testing.T) {
	for _, seed := range []int64{1, 2, 3, 42, 99} {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			const window = 50

			// Generate a history: each key has a fixed event time; some
			// keys get a mutated payload on re-delivery.
			keyTime := make(map[string]int64)
			keyPayload := make(map[string]string)
			var stream []Event
			for i := 0; i < 400; i++ {
				key := fmt.Sprintf("k%03d", rng.Intn(120))
				tm, ok := keyTime[key]
				if !ok {
					tm = int64(rng.Intn(1000))
					keyTime[key] = tm
					keyPayload[key] = fmt.Sprintf("payload-%s", key)
				}
				payload := keyPayload[key]
				if rng.Intn(10) == 0 {
					payload = payload + "-mutated" // conflict injection
				}
				stream = append(stream, ev(key, tm, payload))
			}
			// Out-of-order replay: shuffle the stream.
			rng.Shuffle(len(stream), func(i, j int) {
				stream[i], stream[j] = stream[j], stream[i]
			})

			path := filepath.Join(t.TempDir(), "snap.json")
			store, err := Open(path, window)
			if err != nil {
				t.Fatal(err)
			}
			ref := newModel(window)

			restarted := false
			for i, e := range stream {
				// Midway: snapshot, restart from disk, resume.
				if i == len(stream)/2 && !restarted {
					restarted = true
					if err := store.Save(); err != nil {
						t.Fatal(err)
					}
					store, err = Open(path, window)
					if err != nil {
						t.Fatal(err)
					}
					wmS, okS := store.Watermark()
					if !okS || wmS != ref.watermark {
						t.Fatalf("after restart: store watermark %d,%v; model %d", wmS, okS, ref.watermark)
					}
				}
				// Occasionally inject explicit watermark advances.
				if rng.Intn(20) == 0 {
					adv := int64(rng.Intn(1000))
					store.AdvanceWatermark(adv)
					ref.advance(adv)
				}
				got := store.Ingest(e)
				want := ref.ingest(e)
				if got != want {
					t.Fatalf("step %d event %+v: store=%v model=%v", i, e, got, want)
				}
			}

			// Final state: every retained key must be within the window of
			// the final watermark, and the store must have accepted exactly
			// the keys the model accepted that are still in window.
			wm, _ := store.Watermark()
			want := 0
			for key := range ref.seen {
				if keyTime[key] > wm-window {
					want++
				}
			}
			if got := store.Len(); got != want {
				t.Fatalf("final Len = %d, want %d (in-window accepted keys)", got, want)
			}
		})
	}
}
