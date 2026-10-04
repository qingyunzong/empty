package sim

import (
	"bytes"
	"testing"
)

func run(t *testing.T, seed uint64, nodes, steps int) []byte {
	t.Helper()
	s := New(seed, nodes)
	for i := 0; i < steps; i++ {
		s.Step()
	}
	return s.Output()
}

func TestDeterministicSameSeed(t *testing.T) {
	a := run(t, 42, 5, 500)
	b := run(t, 42, 5, 500)
	if !bytes.Equal(a, b) {
		t.Fatal("same seed produced different output")
	}
}

func TestDifferentSeedsDiffer(t *testing.T) {
	a := run(t, 1, 5, 500)
	b := run(t, 2, 5, 500)
	if bytes.Equal(a, b) {
		t.Fatal("different seeds produced identical output")
	}
}

func TestReplayConsistency(t *testing.T) {
	for _, seed := range []uint64{1, 42, 999, 1 << 40} {
		res := Check(seed, 5, 300)
		if !res.Consistent {
			t.Fatalf("seed=%d: divergence at event %d", seed, res.DivergeAt)
		}
	}
}

func TestSnapshotRoundTripResume(t *testing.T) {
	const seed, nodes, steps, at = 7, 5, 400, 137
	full := New(seed, nodes)
	var snap *Snapshot
	var offset int
	for i := 0; i < steps; i++ {
		if i == at {
			snap = full.Snapshot()
			offset = len(full.Output())
		}
		full.Step()
	}
	fullOut := full.Output()

	// Resume from a snapshot that went through the binary encoding.
	decoded, err := UnmarshalSnapshot(snap.Marshal())
	if err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	rep := New(seed, nodes)
	rep.Restore(decoded)
	for i := at; i < steps; i++ {
		rep.Step()
	}
	if !bytes.Equal(rep.Output(), fullOut[offset:]) {
		t.Fatal("resumed run diverged from full replay")
	}
}

func TestSnapshotContainsPendingQueueAndRNGState(t *testing.T) {
	s := New(11, 5)
	for i := 0; i < 120; i++ {
		s.Step()
	}
	snap := s.Snapshot()
	if snap.RNGState == 0 {
		t.Fatal("snapshot did not capture RNG state")
	}
	if len(snap.Pending) != s.PendingLen() {
		t.Fatalf("snapshot pending=%d, simulator pending=%d", len(snap.Pending), s.PendingLen())
	}
	// RNG streams must match after restore.
	a, b := New(0, 5), New(0, 5)
	a.Restore(s.Snapshot())
	b.Restore(snap)
	for i := 0; i < 50; i++ {
		a.Step()
		b.Step()
	}
	if !bytes.Equal(a.Output(), b.Output()) {
		t.Fatal("restored RNG state diverged")
	}
}

func TestCheckerReportsMinimalDivergence(t *testing.T) {
	const corruptAt = 50
	res := FindDivergence(3, 5, 200, func(i int, snap *Snapshot) {
		if i == corruptAt {
			snap.RNGState ^= 0xDEADBEEF
		}
	})
	if res.Consistent {
		t.Fatal("checker missed injected corruption")
	}
	if res.DivergeAt != corruptAt {
		t.Fatalf("expected minimal divergence at %d, got %d", corruptAt, res.DivergeAt)
	}
}

func TestCheckerReportsEarliestOfMultipleCorruptions(t *testing.T) {
	res := FindDivergence(3, 5, 200, func(i int, snap *Snapshot) {
		if i == 30 || i == 90 {
			snap.NextID += 1000
		}
	})
	if res.DivergeAt != 30 {
		t.Fatalf("expected minimal divergence at 30, got %d", res.DivergeAt)
	}
}
