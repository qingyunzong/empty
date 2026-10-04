package recvwin

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

func digestOf(seq uint64) string { return fmt.Sprintf("d%d", seq) }

func TestInOrderDelivery(t *testing.T) {
	r := New(4)
	for seq := uint64(0); seq < 10; seq++ {
		res, released := r.Receive(seq, digestOf(seq))
		if res != Delivered {
			t.Fatalf("seq %d: got %v, want Delivered", seq, res)
		}
		if !reflect.DeepEqual(released, []uint64{seq}) {
			t.Fatalf("seq %d: released %v", seq, released)
		}
	}
	if r.Base() != 10 || r.Buffered() != 0 {
		t.Fatalf("base=%d buffered=%d", r.Base(), r.Buffered())
	}
}

func TestOutOfOrderBufferedAndPrefixRelease(t *testing.T) {
	r := New(4)
	// Window covers [0,4). Buffer 1 and 2 out of order; nothing acked yet.
	for _, seq := range []uint64{2, 1} {
		res, released := r.Receive(seq, digestOf(seq))
		if res != Buffered || len(released) != 0 {
			t.Fatalf("seq %d: got %v released=%v", seq, res, released)
		}
	}
	if r.Base() != 0 {
		t.Fatalf("base moved to %d without contiguous prefix", r.Base())
	}
	// Arrival of 0 must release the whole contiguous prefix 0,1,2.
	res, released := r.Receive(0, digestOf(0))
	if res != Delivered || !reflect.DeepEqual(released, []uint64{0, 1, 2}) {
		t.Fatalf("got %v released=%v", res, released)
	}
	if r.Base() != 3 || r.Buffered() != 0 {
		t.Fatalf("base=%d buffered=%d", r.Base(), r.Buffered())
	}
}

func TestBackpressureBeyondWindow(t *testing.T) {
	r := New(4)
	if res, _ := r.Receive(4, digestOf(4)); res != Backpressure {
		t.Fatalf("seq 4: got %v, want Backpressure", res)
	}
	if res, _ := r.Receive(3, digestOf(3)); res != Buffered {
		t.Fatalf("seq 3: got %v, want Buffered", res)
	}
	// After the window slides, the formerly rejected seq must be accepted.
	if res, released := r.Receive(0, digestOf(0)); res != Delivered || len(released) != 1 {
		t.Fatalf("seq 0: got %v released=%v", res, released)
	}
	if res, _ := r.Receive(4, digestOf(4)); res != Buffered {
		t.Fatalf("seq 4 after slide: got %v, want Buffered", res)
	}
}

func TestDuplicateAndStale(t *testing.T) {
	r := New(4)
	r.Receive(1, digestOf(1))
	if res, _ := r.Receive(1, digestOf(1)); res != Duplicate {
		t.Fatalf("re-delivery in window: got %v, want Duplicate", res)
	}
	r.Receive(0, digestOf(0)) // releases 0,1; base becomes 2
	if res, _ := r.Receive(0, digestOf(0)); res != Stale {
		t.Fatalf("released seq: got %v, want Stale", res)
	}
	if res, _ := r.Receive(1, digestOf(1)); res != Stale {
		t.Fatalf("released buffered seq: got %v, want Stale", res)
	}
}

func TestConflictSameSeqDifferentDigest(t *testing.T) {
	r := New(4)
	r.Receive(1, "digest-A")
	if res, _ := r.Receive(1, "digest-B"); res != Conflict {
		t.Fatalf("got %v, want Conflict", res)
	}
	// The original frame must be kept: same digest still duplicates,
	// and filling the gap releases 1 with the original content.
	if res, _ := r.Receive(1, "digest-A"); res != Duplicate {
		t.Fatalf("after conflict: got %v, want Duplicate", res)
	}
	if _, released := r.Receive(0, digestOf(0)); !reflect.DeepEqual(released, []uint64{0, 1}) {
		t.Fatalf("released=%v", released)
	}
	// A conflicting retransmission of a still-buffered frame is rejected.
	r.Receive(3, "digest-3")
	if res, _ := r.Receive(3, "other"); res != Conflict {
		t.Fatalf("got %v, want Conflict", res)
	}
}

func TestGapInterval(t *testing.T) {
	r := New(8)
	if lo, hi := r.Gap(); lo != 0 || hi != 7 {
		t.Fatalf("empty gap = [%d,%d], want [0,7]", lo, hi)
	}
	r.Receive(3, digestOf(3))
	r.Receive(5, digestOf(5))
	if lo, hi := r.Gap(); lo != 0 || hi != 2 {
		t.Fatalf("gap = [%d,%d], want [0,2]", lo, hi)
	}
	r.Receive(0, digestOf(0))
	if lo, hi := r.Gap(); lo != 1 || hi != 2 {
		t.Fatalf("gap = [%d,%d], want [1,2]", lo, hi)
	}
	r.Receive(1, digestOf(1))
	r.Receive(2, digestOf(2)) // releases up to 3
	if lo, hi := r.Gap(); lo != 4 || hi != 4 {
		t.Fatalf("gap = [%d,%d], want [4,4]", lo, hi)
	}
}

// model is an independent set-based reference implementation.
type model struct {
	accepted map[uint64]string // seq -> digest for every accepted frame
	base     uint64            // contiguous-prefix length over accepted
}

func newModel() *model { return &model{accepted: make(map[uint64]string)} }

func (m *model) receive(seq uint64, digest string, window int) Result {
	if seq < m.base {
		return Stale
	}
	if seq >= m.base+uint64(window) {
		return Backpressure
	}
	if d, ok := m.accepted[seq]; ok {
		if d == digest {
			return Duplicate
		}
		return Conflict
	}
	m.accepted[seq] = digest
	res := Buffered
	for {
		if _, ok := m.accepted[m.base]; !ok {
			break
		}
		res = Delivered
		m.base++
	}
	return res
}

func (m *model) gap(window int) (uint64, uint64) {
	lo, hi := m.base, m.base+uint64(window)-1
	for seq := range m.accepted {
		if seq > lo && seq-1 < hi {
			hi = seq - 1
		}
	}
	return lo, hi
}

func (m *model) bufferedSet() map[uint64]string {
	out := make(map[uint64]string)
	for seq, d := range m.accepted {
		if seq >= m.base {
			out[seq] = d
		}
	}
	return out
}

func TestRandomArrivalsAgainstSetModel(t *testing.T) {
	const window = 8
	rng := rand.New(rand.NewSource(20261005))
	r := New(window)
	m := newModel()
	acked := make(map[uint64]string) // everything released by the receiver

	for i := 0; i < 20000; i++ {
		// Arrivals cluster around the window with occasional far-future
		// frames (backpressure) and occasional digest corruption (conflict).
		seq := m.base + uint64(rng.Intn(window+4)) - uint64(rng.Intn(3))
		digest := digestOf(seq)
		if rng.Intn(20) == 0 {
			digest = "corrupted"
		}

		gotRes, gotReleased := r.Receive(seq, digest)
		wantRes := m.receive(seq, digest, window)
		if gotRes != wantRes {
			t.Fatalf("iter %d seq %d: got %v, model says %v", i, seq, gotRes, wantRes)
		}

		// Acknowledgement: released set must be exactly the newly
		// contiguous prefix, each seq released exactly once.
		for _, s := range gotReleased {
			if _, dup := acked[s]; dup {
				t.Fatalf("iter %d: seq %d released twice", i, s)
			}
			acked[s] = digestOf(s)
		}
		// Window release: base and buffered contents must match the model.
		if r.Base() != m.base {
			t.Fatalf("iter %d: base %d, model %d", i, r.Base(), m.base)
		}
		if r.Buffered() != len(m.bufferedSet()) {
			t.Fatalf("iter %d: buffered %d, model %d", i, r.Buffered(), len(m.bufferedSet()))
		}

		// Minimal gap interval must match the model.
		lo, hi := r.Gap()
		mlo, mhi := m.gap(window)
		if lo != mlo || hi != mhi {
			t.Fatalf("iter %d: gap [%d,%d], model [%d,%d]", i, lo, hi, mlo, mhi)
		}
	}

	// Every sequence number below the final base must have been acked once.
	for s := uint64(0); s < r.Base(); s++ {
		if _, ok := acked[s]; !ok {
			t.Fatalf("seq %d below base %d never released", s, r.Base())
		}
	}
	t.Logf("final base=%d acked=%d buffered=%d", r.Base(), len(acked), r.Buffered())
}

func TestRandomSeedsSweep(t *testing.T) {
	for seed := int64(0); seed < 50; seed++ {
		const window = 5
		rng := rand.New(rand.NewSource(seed))
		r := New(window)
		m := newModel()
		for i := 0; i < 2000; i++ {
			seq := uint64(rng.Intn(int(m.base) + window + 6))
			digest := digestOf(seq)
			if rng.Intn(15) == 0 {
				digest = "corrupted"
			}
			gotRes, _ := r.Receive(seq, digest)
			if wantRes := m.receive(seq, digest, window); gotRes != wantRes {
				t.Fatalf("seed %d iter %d seq %d: got %v, want %v", seed, i, seq, gotRes, wantRes)
			}
			if r.Base() != m.base {
				t.Fatalf("seed %d iter %d: base %d, model %d", seed, i, r.Base(), m.base)
			}
			lo, hi := r.Gap()
			mlo, mhi := m.gap(window)
			if lo != mlo || hi != mhi {
				t.Fatalf("seed %d iter %d: gap [%d,%d], model [%d,%d]", seed, i, lo, hi, mlo, mhi)
			}
		}
	}
}

func TestBufferedContentsMatchModel(t *testing.T) {
	const window = 6
	rng := rand.New(rand.NewSource(7))
	r := New(window)
	m := newModel()
	for i := 0; i < 5000; i++ {
		seq := uint64(rng.Intn(int(m.base) + window + 3))
		r.Receive(seq, digestOf(seq))
		m.receive(seq, digestOf(seq), window)
	}
	// The receiver must hold exactly the model's in-window, unreleased set.
	want := m.bufferedSet()
	got := make(map[uint64]string)
	for seq := range want {
		if _, ok := r.buf[seq]; !ok {
			t.Fatalf("seq %d missing from receiver buffer", seq)
		}
	}
	for seq, d := range r.buf {
		got[seq] = d
	}
	if !reflect.DeepEqual(got, want) {
		keys := make([]uint64, 0, len(want))
		for s := range want {
			keys = append(keys, s)
		}
		sort.Slice(keys, func(a, b int) bool { return keys[a] < keys[b] })
		t.Fatalf("buffer mismatch: got %v want keys %v", got, keys)
	}
}
