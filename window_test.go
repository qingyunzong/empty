package dedup

import (
	"math/rand"
	"reflect"
	"testing"
)

func TestWindowDecisions(t *testing.T) {
	steps := []struct {
		seq  uint64
		want Decision
	}{
		{5, Accepted},  // first message
		{5, Duplicate}, // high-water mark itself
		{9, Accepted},  // gap jump: 6..8 skipped, allowed
		{7, Accepted},  // gap fill within window
		{7, Duplicate},
		{6, Accepted},
		{8, Accepted},
		{1, Accepted},   // diff 8 == window size, oldest tracked slot
		{0, TooOld},     // diff 9 > window size
		{100, Accepted}, // big jump clears the window
		{99, Accepted},
		{9, TooOld}, // fell out of the window
		{91, TooOld},
		{92, Accepted}, // diff 8, oldest tracked slot
		{92, Duplicate},
	}
	w := NewWindow(8)
	for i, st := range steps {
		if got := w.Observe(st.seq); got != st.want {
			t.Fatalf("step %d: Observe(%d) = %v, want %v", i, st.seq, got, st.want)
		}
	}
}

// setModel is the naive full-set reference for window decisions.
type setModel struct {
	seen map[uint64]bool
	high uint64
	has  bool
	size int
}

func (m *setModel) observe(seq uint64) Decision {
	if !m.has {
		m.has = true
		m.high = seq
		m.seen[seq] = true
		return Accepted
	}
	if seq > m.high {
		m.high = seq
		m.seen[seq] = true
		return Accepted
	}
	if m.high-seq > uint64(m.size) {
		return TooOld
	}
	if m.seen[seq] {
		return Duplicate
	}
	m.seen[seq] = true
	return Accepted
}

func TestWindowAgainstSetModel(t *testing.T) {
	for _, size := range []int{1, 7, 64, 100, 1000} {
		rng := rand.New(rand.NewSource(int64(size)))
		w := NewWindow(size)
		model := &setModel{seen: make(map[uint64]bool), size: size}
		var high uint64
		for i := 0; i < 50000; i++ {
			var seq uint64
			switch rng.Intn(10) {
			case 0, 1: // jump far ahead
				high += uint64(rng.Intn(3 * size))
				seq = high
			case 2, 3, 4: // somewhere below the high-water mark
				if high > 0 {
					seq = uint64(rng.Intn(int(high) + 1))
				}
			default: // near the high-water mark
				if d := uint64(rng.Intn(2*size + 2)); high > d {
					seq = high - d
				}
			}
			if got, want := w.Observe(seq), model.observe(seq); got != want {
				t.Fatalf("size=%d iter=%d seq=%d: got %v, want %v", size, i, seq, got, want)
			}
			if high < seq {
				high = seq
			}
		}
		// Seen must agree with the model for every slot in the window.
		for i := uint64(0); i <= uint64(size); i++ {
			seq := high - i
			if got, want := w.Seen(seq), model.seen[seq]; got != want {
				t.Fatalf("size=%d Seen(%d) = %v, want %v", size, seq, got, want)
			}
		}
	}
}

func TestWindowSerializationRoundTrip(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	w := NewWindow(100)
	high := uint64(0)
	for i := 0; i < 5000; i++ {
		switch rng.Intn(3) {
		case 0:
			high += uint64(rng.Intn(300))
			w.Observe(high)
		default:
			if high > 0 {
				w.Observe(uint64(rng.Intn(int(high) + 1)))
			}
		}
	}
	buf := w.appendTo(nil)
	d := &decoder{buf: buf}
	got := d.window()
	if d.err != nil {
		t.Fatalf("decode: %v", d.err)
	}
	if d.off != len(buf) {
		t.Fatalf("trailing bytes: %d of %d consumed", d.off, len(buf))
	}
	if got.Has != w.Has || got.High != w.High || got.Size != w.Size ||
		!reflect.DeepEqual(got.Bits, w.Bits) {
		t.Fatalf("round trip mismatch:\n got: %+v\nwant: %+v", got, w)
	}
}
