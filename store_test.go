package sessionstore

import (
	"errors"
	"sync"
	"testing"
)

func TestReconnectIncrementsGeneration(t *testing.T) {
	s := New()
	g1 := s.Connect()
	g2 := s.Connect()
	g3 := s.Connect()
	if !(g1 < g2 && g2 < g3) {
		t.Fatalf("generations not strictly increasing: %d, %d, %d", g1, g2, g3)
	}
	if s.Generation() != g3 {
		t.Fatalf("current generation = %d, want %d", s.Generation(), g3)
	}
}

func TestStaleGenerationInFlightRejected(t *testing.T) {
	s := New()
	g1 := s.Connect()
	if _, err := s.Apply(g1, 1, Op{Key: "a", Delta: 1}); err != nil {
		t.Fatalf("gen1 apply: %v", err)
	}
	// Reconnect while a gen1 request is still in flight.
	g2 := s.Connect()
	if _, err := s.Apply(g1, 2, Op{Key: "a", Delta: 100}); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale in-flight apply: got %v, want ErrStaleGeneration", err)
	}
	if _, err := s.State(g1); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale state read: got %v, want ErrStaleGeneration", err)
	}
	st, err := s.State(g2)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st["a"] != 1 {
		t.Fatalf("stale request leaked into state: a = %d, want 1", st["a"])
	}
}

func TestDuplicateSeqReturnsOriginalResult(t *testing.T) {
	s := New()
	g := s.Connect()
	first, err := s.Apply(g, 7, Op{Key: "n", Delta: 5})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	dup, err := s.Apply(g, 7, Op{Key: "n", Delta: 5})
	if err != nil {
		t.Fatalf("duplicate apply: %v", err)
	}
	if dup != first && !(dup.Value == first.Value && dup.Seq == first.Seq && dup.Generation == first.Generation) {
		t.Fatalf("duplicate returned %+v, want original %+v", dup, first)
	}
	if !dup.Replayed {
		t.Fatal("duplicate not marked as replayed")
	}
	st, _ := s.State(g)
	if st["n"] != 5 {
		t.Fatalf("operation applied twice: n = %d, want 5", st["n"])
	}
}

func TestDisconnectDoesNotRollBack(t *testing.T) {
	s := New()
	g1 := s.Connect()
	for seq := uint64(1); seq <= 3; seq++ {
		if _, err := s.Apply(g1, seq, Op{Key: "k", Delta: 10}); err != nil {
			t.Fatalf("apply seq %d: %v", seq, err)
		}
	}
	// Disconnect and reconnect: committed operations must survive.
	g2 := s.Connect()
	st, err := s.State(g2)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st["k"] != 30 {
		t.Fatalf("committed ops rolled back: k = %d, want 30", st["k"])
	}
}

func TestInterleavedEventsCurrentGenerationOnly(t *testing.T) {
	s := New()
	g1 := s.Connect()
	if _, err := s.Apply(g1, 1, Op{Key: "x", Delta: 1}); err != nil {
		t.Fatalf("g1 apply: %v", err)
	}
	g2 := s.Connect()

	// Interleave: stale gen1 traffic, fresh gen2 traffic, gen2 duplicate.
	if _, err := s.Apply(g1, 2, Op{Key: "x", Delta: 1000}); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale apply accepted: %v", err)
	}
	// Seq 1 was used in gen1; the dedup cache must not leak across generations.
	res, err := s.Apply(g2, 1, Op{Key: "x", Delta: 2})
	if err != nil {
		t.Fatalf("g2 apply: %v", err)
	}
	if res.Replayed {
		t.Fatal("g2 seq 1 wrongly served from gen1 dedup cache")
	}
	if res.Generation != g2 {
		t.Fatalf("result generation = %d, want %d", res.Generation, g2)
	}
	dup, err := s.Apply(g2, 1, Op{Key: "x", Delta: 2})
	if err != nil || !dup.Replayed || dup.Value != res.Value {
		t.Fatalf("g2 duplicate: %+v, err %v", dup, err)
	}
	if _, err := s.State(g1); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale state read accepted: %v", err)
	}
	st, err := s.State(g2)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	// Only gen1's committed op (1) and gen2's committed op (2) count.
	if st["x"] != 3 {
		t.Fatalf("state x = %d, want 3 (stale/duplicate ops must not apply)", st["x"])
	}
}

func TestConcurrentInFlightAcrossReconnect(t *testing.T) {
	s := New()
	g1 := s.Connect()
	g2 := s.Connect()

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func(seq uint64) {
			defer wg.Done()
			s.Apply(g1, seq, Op{Key: "c", Delta: 1}) // must all be rejected
		}(uint64(i))
		go func(seq uint64) {
			defer wg.Done()
			res, err := s.Apply(g2, seq, Op{Key: "c", Delta: 1})
			if err != nil {
				t.Errorf("current-gen apply: %v", err)
			}
			if err == nil && res.Generation != g2 {
				t.Errorf("result from generation %d, want %d", res.Generation, g2)
			}
		}(uint64(i))
	}
	wg.Wait()

	st, err := s.State(g2)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st["c"] != 50 {
		t.Fatalf("c = %d, want 50 (only current-generation ops applied)", st["c"])
	}
}
