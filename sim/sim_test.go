package sim

import (
	"bytes"
	"testing"
)

func TestDeterministicReplay(t *testing.T) {
	cfg := Config{NumNodes: 4, Seed: 42}
	events := Generate(cfg, 300)

	a := New(cfg)
	a.Run(events, 0, len(events))
	b := New(cfg)
	b.Run(events, 0, len(events))

	if !bytes.Equal(a.StateBytes(), b.StateBytes()) {
		t.Fatal("two full replays with the same seed diverged")
	}
}

func TestEventGenerationDeterministic(t *testing.T) {
	cfg := Config{NumNodes: 3, Seed: 7}
	e1 := Generate(cfg, 100)
	e2 := Generate(cfg, 100)
	if len(e1) != len(e2) {
		t.Fatalf("length mismatch: %d vs %d", len(e1), len(e2))
	}
	for i := range e1 {
		if e1[i] != e2[i] {
			t.Fatalf("event %d differs: %v vs %v", i, e1[i], e2[i])
		}
	}
}

func TestDifferentSeedsDiverge(t *testing.T) {
	a := New(Config{NumNodes: 3, Seed: 1})
	b := New(Config{NumNodes: 3, Seed: 2})
	ea := Generate(Config{NumNodes: 3, Seed: 1}, 200)
	eb := Generate(Config{NumNodes: 3, Seed: 2}, 200)
	a.Run(ea, 0, len(ea))
	b.Run(eb, 0, len(eb))
	if bytes.Equal(a.StateBytes(), b.StateBytes()) {
		t.Fatal("different seeds produced identical states")
	}
}

// TestSnapshotJumpConsistency is the core property: jumping to any event
// via a snapshot and continuing must match the full replay byte-for-byte.
func TestSnapshotJumpConsistency(t *testing.T) {
	for seed := uint64(1); seed <= 8; seed++ {
		cfg := Config{NumNodes: 4, Seed: seed}
		events := Generate(cfg, 200)
		if got := FindMinimalDivergence(cfg, events, (*Sim).Snapshot); got != -1 {
			t.Fatalf("seed %d: divergence at event %d (%v), want -1", seed, got, events[got])
		}
	}
}

// TestSnapshotCoversQueueAndRNG ensures the snapshot actually carries the
// pending queue and RNG state: tampering with either must be detectable.
func TestSnapshotCoversQueueAndRNG(t *testing.T) {
	cfg := Config{NumNodes: 3, Seed: 11}
	events := Generate(cfg, 120)

	// Find an index where the queue is non-empty so tampering matters.
	head := New(cfg)
	queueIdx := -1
	for i := 0; i < len(events); i++ {
		head.Step(events[i])
		if queueIdx == -1 && head.QueueLen() > 0 {
			queueIdx = head.Cursor()
		}
	}
	if queueIdx == -1 {
		t.Fatal("no event produced a non-empty queue")
	}

	dropQueue := func(s *Sim) Snapshot {
		snap := s.Snapshot()
		if s.Cursor() == queueIdx && len(snap.Queue) > 0 {
			snap.Queue = snap.Queue[:len(snap.Queue)-1]
		}
		return snap
	}
	if got := FindMinimalDivergence(cfg, events, dropQueue); got != queueIdx {
		t.Fatalf("queue-tampering divergence at %d, want %d", got, queueIdx)
	}

	rngIdx := 17
	corruptRNG := func(s *Sim) Snapshot {
		snap := s.Snapshot()
		if s.Cursor() == rngIdx {
			snap.RNGState ^= 0xdeadbeef
		}
		return snap
	}
	if got := FindMinimalDivergence(cfg, events, corruptRNG); got != rngIdx {
		t.Fatalf("rng-tampering divergence at %d, want %d", got, rngIdx)
	}
}

// TestFindMinimalDivergence checks that the checker reports the minimal
// inconsistent event position when a snapshotter is faulty at several
// indices.
func TestFindMinimalDivergence(t *testing.T) {
	cfg := Config{NumNodes: 3, Seed: 5}
	events := Generate(cfg, 150)

	corruptAt := map[int]bool{40: true, 25: true, 90: true}
	buggy := func(s *Sim) Snapshot {
		snap := s.Snapshot()
		if corruptAt[s.Cursor()] && len(snap.Delivered) > 0 {
			// Drop a delivered record: the append-only history keeps the
			// corruption visible in the final digest.
			snap.Delivered = snap.Delivered[:len(snap.Delivered)-1]
		}
		return snap
	}
	if got := FindMinimalDivergence(cfg, events, buggy); got != 25 {
		t.Fatalf("minimal divergence = %d, want 25", got)
	}
}

// TestRestoreIndependence ensures mutating the restored simulator does not
// affect the original snapshot source.
func TestRestoreIndependence(t *testing.T) {
	cfg := Config{NumNodes: 3, Seed: 9}
	events := Generate(cfg, 100)

	head := New(cfg)
	head.Run(events, 0, 50)
	snap := head.Snapshot()

	jumped := Restore(cfg, snap)
	jumped.Run(events, 50, len(events))

	// Re-restore from the same snapshot must give the identical result.
	again := Restore(cfg, snap)
	again.Run(events, 50, len(events))
	if !bytes.Equal(jumped.StateBytes(), again.StateBytes()) {
		t.Fatal("restores from the same snapshot diverged")
	}
}
