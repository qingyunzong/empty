package cover

import (
	"errors"
	"math/rand"
	"path/filepath"
	"reflect"
	"testing"
)

// model is the reference set-accumulation semantics: the accumulated
// count of an edge is the sum, over the SET of distinct run IDs, of
// that run's count for the edge. Duplicate run IDs contribute once;
// foreign digests and 64-bit overflows are errors.
type model struct {
	digest Digest
	runs   map[uint64]struct{}
	counts map[uint64]uint64
}

func newModel(d Digest) *model {
	return &model{digest: d, runs: make(map[uint64]struct{}), counts: make(map[uint64]uint64)}
}

func (m *model) merge(d Delta) (bool, error) {
	if d.Digest != m.digest {
		return false, ErrDigestMismatch
	}
	if _, ok := m.runs[d.RunID]; ok {
		return false, nil
	}
	for id, c := range d.Edges {
		if m.counts[id]+c < m.counts[id] { // uint64 wrap
			return false, ErrOverflow
		}
	}
	for id, c := range d.Edges {
		m.counts[id] += c
	}
	m.runs[d.RunID] = struct{}{}
	return true, nil
}

// randomDelta builds a delta with small counts so overflow never
// triggers unless the test arranges it.
func randomDelta(rng *rand.Rand, digest Digest, runIDs, edgeIDs int) Delta {
	edges := make(map[uint64]uint64)
	for _, id := range rng.Perm(edgeIDs)[:rng.Intn(edgeIDs)] {
		edges[uint64(id)] = uint64(rng.Intn(1000))
	}
	return Delta{Digest: digest, RunID: uint64(rng.Intn(runIDs)), Edges: edges}
}

// TestStoreMatchesModel drives the store and the reference model with
// identical random op sequences (including duplicate run IDs and
// foreign digests) and requires identical results after every step.
func TestStoreMatchesModel(t *testing.T) {
	for _, seed := range []int64{1, 7, 99, 20261005} {
		rng := rand.New(rand.NewSource(seed))
		s := NewStore(srcA)
		m := newModel(srcA)
		for step := 0; step < 2000; step++ {
			digest := srcA
			if rng.Intn(10) == 0 {
				digest = srcB // foreign source must be rejected by both
			}
			d := randomDelta(rng, digest, 12, 8)
			okS, errS := s.Merge(d)
			okM, errM := m.merge(d)
			if okS != okM || (errS == nil) != (errM == nil) {
				t.Fatalf("seed %d step %d: store (%v,%v) != model (%v,%v)", seed, step, okS, errS, okM, errM)
			}
			if errS != nil && digest == srcB && !errors.Is(errS, ErrDigestMismatch) {
				t.Fatalf("seed %d step %d: foreign digest err = %v", seed, step, errS)
			}
			if !reflect.DeepEqual(s.Snapshot(), m.counts) {
				t.Fatalf("seed %d step %d: counts diverged\nstore: %v\nmodel: %v", seed, step, s.Snapshot(), m.counts)
			}
			if s.Runs() != len(m.runs) {
				t.Fatalf("seed %d step %d: run sets diverged", seed, step)
			}
		}
	}
}

// TestOutOfOrderReplayMatchesModel merges a random batch of deltas
// through the WAL, then replays the persisted records in many random
// orders. Every order must converge to the same state, equal to the
// model's, because dedup is by run ID and addition commutes.
func TestOutOfOrderReplayMatchesModel(t *testing.T) {
	rng := rand.New(rand.NewSource(31337))
	m := newModel(srcA)
	var accepted []Delta
	for i := 0; i < 300; i++ {
		d := randomDelta(rng, srcA, 40, 12)
		if ok, err := m.merge(d); err != nil {
			t.Fatalf("model rejected in-order delta: %v", err)
		} else if ok {
			accepted = append(accepted, d)
		}
	}
	if len(accepted) == 0 {
		t.Fatal("no deltas accepted")
	}

	// Persist the accepted deltas through a Log (also exercises the WAL).
	path := filepath.Join(t.TempDir(), "cover.wal")
	l, err := Open(path, srcA)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range accepted {
		if ok, err := l.Merge(d); !ok || err != nil {
			t.Fatalf("log merge: ok=%v err=%v", ok, err)
		}
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	if got := l.Store().Snapshot(); !reflect.DeepEqual(got, m.counts) {
		t.Fatalf("in-order log state != model\nlog:   %v\nmodel: %v", got, m.counts)
	}

	recorded, err := ReadWAL(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(recorded) != len(accepted) {
		t.Fatalf("WAL holds %d records, want %d", len(recorded), len(accepted))
	}

	// Replay the recorded records in 200 random orders, plus orders
	// with each record duplicated, and compare against the model.
	for trial := 0; trial < 200; trial++ {
		order := rng.Perm(len(recorded))
		s := NewStore(srcA)
		for _, idx := range order {
			if _, err := s.Merge(recorded[idx]); err != nil {
				t.Fatalf("trial %d: replay merge: %v", trial, err)
			}
		}
		// Inject duplicate deliveries at random positions.
		for i := 0; i < 5; i++ {
			if _, err := s.Merge(recorded[rng.Intn(len(recorded))]); err != nil {
				t.Fatalf("trial %d: duplicate merge: %v", trial, err)
			}
		}
		if got := s.Snapshot(); !reflect.DeepEqual(got, m.counts) {
			t.Fatalf("trial %d: out-of-order replay != model\nreplay: %v\nmodel:  %v", trial, got, m.counts)
		}
		if s.Runs() != len(m.runs) {
			t.Fatalf("trial %d: Runs() = %d, want %d", trial, s.Runs(), len(m.runs))
		}
	}
}

// TestRecoveryEqualsModelAfterEachMerge checkpoints: after every
// merge, reopening the WAL from disk must reproduce the model state.
func TestRecoveryEqualsModelAfterEachMerge(t *testing.T) {
	rng := rand.New(rand.NewSource(777))
	path := filepath.Join(t.TempDir(), "cover.wal")
	m := newModel(srcA)
	l, err := Open(path, srcA)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 60; i++ {
		d := randomDelta(rng, srcA, 15, 10)
		okM, errM := m.merge(d)
		okL, errL := l.Merge(d)
		if okM != okL || (errM == nil) != (errL == nil) {
			t.Fatalf("step %d: log (%v,%v) != model (%v,%v)", i, okL, errL, okM, errM)
		}
		if err := l.Close(); err != nil {
			t.Fatal(err)
		}
		l, err = Open(path, srcA)
		if err != nil {
			t.Fatalf("step %d: reopen: %v", i, err)
		}
		if got := l.Store().Snapshot(); !reflect.DeepEqual(got, m.counts) {
			t.Fatalf("step %d: recovered state != model\nrecovered: %v\nmodel:     %v", i, got, m.counts)
		}
	}
	l.Close()
}
