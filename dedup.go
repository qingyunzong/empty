// Package dedup provides a consumer-side deduplication library keyed by
// (producer ID, sequence number). Sequence gaps are tolerated; messages
// that fall below the sliding window are reported as explicitly too old.
package dedup

import "fmt"

// Decision is the outcome of observing a (producer, seq) pair.
type Decision int

const (
	// New means the pair was never seen and is now recorded.
	New Decision = iota
	// Duplicate means the pair is inside the window and was already seen.
	Duplicate
	// TooOld means the sequence number fell below the sliding window; the
	// library can no longer distinguish duplicate from unseen, so the
	// message is explicitly rejected as too old.
	TooOld
)

func (d Decision) String() string {
	switch d {
	case New:
		return "new"
	case Duplicate:
		return "duplicate"
	case TooOld:
		return "too-old"
	}
	return fmt.Sprintf("decision(%d)", int(d))
}

// window is a per-producer bitmap of the last windowSize sequence numbers.
// Bit i (0-based) corresponds to sequence number max-i.
type window struct {
	max  uint64
	has  bool
	bits []uint64
}

// Set tracks seen (producer, seq) pairs with a per-producer sliding window.
type Set struct {
	size int // window size in sequence numbers, multiple of 64
	m    map[string]*window
}

// NewSet creates a Set with the given window size per producer. The size is
// rounded up to a multiple of 64 and is at least 64.
func NewSet(windowSize int) *Set {
	if windowSize < 64 {
		windowSize = 64
	}
	windowSize = (windowSize + 63) / 64 * 64
	return &Set{size: windowSize, m: make(map[string]*window)}
}

// WindowSize returns the effective per-producer window size.
func (s *Set) WindowSize() int { return s.size }

// Observe reports whether (producer, seq) is New, Duplicate or TooOld and,
// when New, records it. Gaps in the sequence are allowed: unseen numbers
// inside the window simply remain unset bits until observed or aged out.
func (s *Set) Observe(producer string, seq uint64) Decision {
	w := s.m[producer]
	if w == nil {
		w = &window{bits: make([]uint64, s.size/64)}
		s.m[producer] = w
	}
	if !w.has {
		w.has = true
		w.max = seq
		w.bits[0] |= 1
		return New
	}
	if seq > w.max {
		w.shift(seq - w.max)
		w.max = seq
		w.bits[0] |= 1
		return New
	}
	d := w.max - seq
	if d >= uint64(s.size) {
		return TooOld
	}
	word, bit := d/64, d%64
	mask := uint64(1) << bit
	if w.bits[word]&mask != 0 {
		return Duplicate
	}
	w.bits[word] |= mask
	return New
}

// shift moves the window forward by n sequence numbers (bit i becomes bit
// i+n), discarding bits that fall out of the window.
func (w *window) shift(n uint64) {
	words := len(w.bits)
	if n >= uint64(words*64) {
		for i := range w.bits {
			w.bits[i] = 0
		}
		return
	}
	whole, rem := int(n/64), uint(n%64)
	for i := words - 1; i >= 0; i-- {
		var v uint64
		if src := i - whole; src >= 0 {
			v = w.bits[src] << rem
			if rem != 0 && src-1 >= 0 {
				v |= w.bits[src-1] >> (64 - rem)
			}
		}
		w.bits[i] = v
	}
}
