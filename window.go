package dedup

import "encoding/binary"

// Decision is the outcome of deduplicating one message.
type Decision int

const (
	// Accepted means the message is new; its effect was committed.
	Accepted Decision = iota
	// Duplicate means the (producer, seq) pair was already accepted.
	Duplicate
	// TooOld means the sequence number fell below the dedup window and
	// can no longer be tracked; it is conservatively rejected.
	TooOld
)

func (d Decision) String() string {
	switch d {
	case Accepted:
		return "Accepted"
	case Duplicate:
		return "Duplicate"
	case TooOld:
		return "TooOld"
	}
	return "Unknown"
}

// Window tracks the seen sequence numbers of a single producer as a
// high-water mark plus a bitmap of the Size slots below it. Sequence
// gaps are allowed: any unseen seq above High-Size is accepted exactly
// once; seq <= High-Size is reported TooOld.
type Window struct {
	High uint64   // highest sequence number ever observed
	Has  bool     // whether any sequence number was observed
	Size int      // number of tracked slots below High
	Bits []uint64 // bit i set => seq High-1-i was observed
}

// NewWindow returns an empty Window tracking size slots below the
// high-water mark.
func NewWindow(size int) Window {
	if size <= 0 {
		size = 1
	}
	return Window{Size: size, Bits: make([]uint64, (size+63)/64)}
}

// Observe records seq and reports whether it is new.
func (w *Window) Observe(seq uint64) Decision {
	if !w.Has {
		w.Has = true
		w.High = seq
		return Accepted
	}
	if seq > w.High {
		s := seq - w.High
		w.Bits = shiftBits(w.Bits, w.Size, s)
		if s <= uint64(w.Size) {
			// Materialize the old high-water mark into the bitmap.
			idx := s - 1
			w.Bits[idx/64] |= uint64(1) << (idx % 64)
		}
		w.High = seq
		return Accepted
	}
	diff := w.High - seq
	if diff == 0 {
		return Duplicate
	}
	if diff > uint64(w.Size) {
		return TooOld
	}
	idx := diff - 1
	mask := uint64(1) << (idx % 64)
	if w.Bits[idx/64]&mask != 0 {
		return Duplicate
	}
	w.Bits[idx/64] |= mask
	return Accepted
}

// Seen reports whether seq is certainly recorded as observed. It returns
// false for sequence numbers that fell below the window.
func (w Window) Seen(seq uint64) bool {
	if !w.Has || seq > w.High {
		return false
	}
	diff := w.High - seq
	if diff == 0 {
		return true
	}
	if diff > uint64(w.Size) {
		return false
	}
	idx := diff - 1
	return w.Bits[idx/64]&(uint64(1)<<(idx%64)) != 0
}

// Clone returns a deep copy of w.
func (w Window) Clone() Window {
	bits := make([]uint64, len(w.Bits))
	copy(bits, w.Bits)
	w.Bits = bits
	return w
}

// shiftBits moves every set bit up by s positions (towards the new,
// higher high-water mark), dropping bits that leave the window.
func shiftBits(bits []uint64, size int, s uint64) []uint64 {
	out := make([]uint64, len(bits))
	if s >= uint64(size) {
		return out
	}
	ws, bs := s/64, s%64
	for i := len(out) - 1; i >= int(ws); i-- {
		src := i - int(ws)
		out[i] = bits[src] << bs
		if bs > 0 && src > 0 {
			out[i] |= bits[src-1] >> (64 - bs)
		}
	}
	if r := size % 64; r != 0 {
		out[len(out)-1] &= (uint64(1) << r) - 1
	}
	return out
}

func (w Window) appendTo(buf []byte) []byte {
	var has byte
	if w.Has {
		has = 1
	}
	buf = append(buf, has)
	buf = binary.BigEndian.AppendUint64(buf, w.High)
	buf = binary.BigEndian.AppendUint32(buf, uint32(w.Size))
	buf = binary.BigEndian.AppendUint32(buf, uint32(len(w.Bits)))
	for _, word := range w.Bits {
		buf = binary.BigEndian.AppendUint64(buf, word)
	}
	return buf
}
