package recvwin

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

func digest(b byte) [32]byte {
	var d [32]byte
	d[0] = b
	return d
}

func TestContiguousPrefixAck(t *testing.T) {
	w := New(0, 4)
	for seq := uint64(0); seq < 4; seq++ {
		res, err := w.Insert(seq, digest(byte(seq)))
		if err != nil {
			t.Fatalf("insert %d: %v", seq, err)
		}
		if res.Outcome != Stored || res.Ack != seq+1 || res.Released != 1 {
			t.Fatalf("insert %d: got %+v", seq, res)
		}
	}
	if w.Ack() != 4 || w.Buffered() != 0 {
		t.Fatalf("ack=%d buffered=%d", w.Ack(), w.Buffered())
	}
}

func TestOutOfOrderBufferedThenReleased(t *testing.T) {
	w := New(10, 8)
	if res, _ := w.Insert(12, digest(12)); res.Ack != 10 || res.Released != 0 {
		t.Fatalf("out-of-order insert: %+v", res)
	}
	if res, _ := w.Insert(11, digest(11)); res.Ack != 10 || res.Released != 0 {
		t.Fatalf("out-of-order insert: %+v", res)
	}
	res, err := w.Insert(10, digest(10))
	if err != nil || res.Ack != 13 || res.Released != 3 {
		t.Fatalf("gap-filling insert: %+v err=%v", res, err)
	}
	if w.Buffered() != 0 {
		t.Fatalf("buffered=%d", w.Buffered())
	}
}

func TestBackpressureBeyondWindow(t *testing.T) {
	w := New(0, 4)
	if _, err := w.Insert(4, digest(4)); !errors.Is(err, ErrBackpressure) {
		t.Fatalf("want backpressure, got %v", err)
	}
	if _, err := w.Insert(100, digest(100)); !errors.Is(err, ErrBackpressure) {
		t.Fatalf("want backpressure, got %v", err)
	}
	// Window state must be untouched by rejected frames.
	if w.Ack() != 0 || w.Buffered() != 0 {
		t.Fatalf("state mutated by backpressured frame")
	}
	// After the frontier advances, the same sequence is accepted.
	if _, err := w.Insert(0, digest(0)); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Insert(4, digest(4)); err != nil {
		t.Fatalf("seq 4 should fit after advance: %v", err)
	}
}

func TestConflictSameSeqDifferentDigest(t *testing.T) {
	w := New(0, 4)
	if _, err := w.Insert(2, digest(0xAA)); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Insert(2, digest(0xBB)); !errors.Is(err, ErrConflict) {
		t.Fatalf("want conflict, got %v", err)
	}
	// Original digest must survive the conflicting delivery.
	if _, err := w.Insert(2, digest(0xAA)); err != nil {
		t.Fatalf("re-delivering original digest: %v", err)
	}
	res, _ := w.Insert(0, digest(0))
	if res.Ack != 1 {
		t.Fatalf("conflict must not corrupt frontier: %+v", res)
	}
}

func TestDuplicates(t *testing.T) {
	w := New(0, 4)
	w.Insert(1, digest(1))
	if res, _ := w.Insert(1, digest(1)); res.Outcome != Duplicate {
		t.Fatalf("buffered dup: %+v", res)
	}
	w.Insert(0, digest(0))
	if res, err := w.Insert(0, digest(0)); err != nil || res.Outcome != Duplicate {
		t.Fatalf("already-acked dup: %+v err=%v", res, err)
	}
	// A different digest below the frontier is unverifiable, not a conflict.
	if _, err := w.Insert(0, digest(0xFF)); err != nil {
		t.Fatalf("below-frontier redelivery: %v", err)
	}
}

func TestGapMinimalInterval(t *testing.T) {
	w := New(5, 6) // window [5, 11)
	if lo, hi := w.Gap(); lo != 5 || hi != 11 {
		t.Fatalf("empty window gap = [%d,%d)", lo, hi)
	}
	w.Insert(8, digest(8))
	w.Insert(10, digest(10))
	if lo, hi := w.Gap(); lo != 5 || hi != 8 {
		t.Fatalf("gap = [%d,%d), want [5,8)", lo, hi)
	}
	w.Insert(5, digest(5))
	w.Insert(6, digest(6))
	w.Insert(7, digest(7))
	// 5-8 form a contiguous prefix and are all released; 10 stays buffered.
	if w.Ack() != 9 {
		t.Fatalf("ack = %d, want 9", w.Ack())
	}
	if lo, hi := w.Gap(); lo != 9 || hi != 10 {
		t.Fatalf("after release gap = [%d,%d), want [9,10)", lo, hi)
	}
}

// setModel is an independent set-based reference implementation. It tracks
// only a frontier and a set of buffered (sequence, digest) pairs, and
// derives ack and window release from set membership alone.
type setModel struct {
	frontier uint64
	size     uint64
	pending  map[uint64][32]byte
}

func newSetModel(start, size uint64) *setModel {
	return &setModel{frontier: start, size: size, pending: make(map[uint64][32]byte)}
}

func (m *setModel) insert(seq uint64, dg [32]byte) (Result, error) {
	switch {
	case seq < m.frontier:
		return Result{Outcome: Duplicate, Ack: m.frontier}, nil
	case seq-m.frontier >= m.size:
		return Result{Ack: m.frontier}, ErrBackpressure
	}
	if prev, ok := m.pending[seq]; ok {
		if prev != dg {
			return Result{Ack: m.frontier}, ErrConflict
		}
		return Result{Outcome: Duplicate, Ack: m.frontier}, nil
	}
	m.pending[seq] = dg
	released := 0
	for {
		if _, ok := m.pending[m.frontier]; !ok {
			break
		}
		delete(m.pending, m.frontier)
		m.frontier++
		released++
	}
	return Result{Outcome: Stored, Ack: m.frontier, Released: released}, nil
}

func (m *setModel) gap() (uint64, uint64) {
	lo := m.frontier
	hi := m.frontier + m.size
	for seq := range m.pending {
		if seq < hi {
			hi = seq
		}
	}
	return lo, hi
}

// TestRandomArrivalsAgainstSetModel drives the window with random arrivals
// (in-window, duplicate, conflicting, and beyond-window frames) and checks
// ack frontier, window release, buffered contents, and the minimal gap
// interval against the set model after every single operation.
func TestRandomArrivalsAgainstSetModel(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	const trials = 200
	for trial := 0; trial < trials; trial++ {
		size := uint64(1 + rng.Intn(16))
		start := uint64(rng.Intn(1000))
		w := New(start, size)
		m := newSetModel(start, size)

		ops := 50 + rng.Intn(200)
		for op := 0; op < ops; op++ {
			var seq uint64
			var dg [32]byte
			switch rng.Intn(10) {
			case 0: // beyond-window frame -> backpressure
				seq = m.frontier + size + uint64(rng.Intn(8))
				dg = digest(byte(rng.Intn(4)))
			case 1: // stale frame below the frontier
				if m.frontier > 0 {
					seq = uint64(rng.Intn(int(m.frontier)))
				}
				dg = digest(byte(rng.Intn(4)))
			case 2: // conflicting digest on a buffered sequence
				if len(m.pending) > 0 {
					seqs := make([]uint64, 0, len(m.pending))
					for s := range m.pending {
						seqs = append(seqs, s)
					}
					seq = seqs[rng.Intn(len(seqs))]
					dg = m.pending[seq]
					dg[0] ^= 0xFF
					break
				}
				fallthrough
			default: // in-window frame, biased toward the frontier
				seq = m.frontier + uint64(rng.Intn(int(size)))
				dg = digest(byte(seq % 4)) // stable digest per seq class
			}

			gotRes, gotErr := w.Insert(seq, dg)
			wantRes, wantErr := m.insert(seq, dg)

			if (gotErr != nil) != (wantErr != nil) ||
				(gotErr != nil && !errors.Is(gotErr, wantErr)) {
				t.Fatalf("trial %d op %d seq=%d: err got %v want %v",
					trial, op, seq, gotErr, wantErr)
			}
			if gotRes != wantRes {
				t.Fatalf("trial %d op %d seq=%d: result got %+v want %+v",
					trial, op, seq, gotRes, wantRes)
			}
			if w.Ack() != m.frontier {
				t.Fatalf("trial %d op %d: ack got %d want %d",
					trial, op, w.Ack(), m.frontier)
			}
			if w.Buffered() != len(m.pending) {
				t.Fatalf("trial %d op %d: buffered got %d want %d",
					trial, op, w.Buffered(), len(m.pending))
			}
			gotLo, gotHi := w.Gap()
			wantLo, wantHi := m.gap()
			if gotLo != wantLo || gotHi != wantHi {
				t.Fatalf("trial %d op %d: gap got [%d,%d) want [%d,%d)",
					trial, op, gotLo, gotHi, wantLo, wantHi)
			}
		}

		// Final state: buffered contents must match the model's set exactly.
		got := make(map[uint64][32]byte, w.Buffered())
		for seq := start; seq < w.Ack()+size; seq++ {
			if seq < w.Ack() {
				continue
			}
			if _, ok := w.buf[seq]; ok {
				got[seq] = w.buf[seq]
			}
		}
		if !reflect.DeepEqual(got, m.pending) {
			t.Fatalf("trial %d: final buffer mismatch got %v want %v",
				trial, got, m.pending)
		}
	}
}
