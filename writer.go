package telemcodec

// BitWriter appends bits to a growable buffer according to a BitOrder.
// The cursor is bit-granular and supports transactional mark/rollback.
type BitWriter struct {
	order BitOrder
	buf   []byte
	pos   int64 // total bits written
}

func NewBitWriter(order BitOrder) *BitWriter {
	if !order.valid() {
		order = MSBFirst
	}
	return &BitWriter{order: order}
}

// Pos returns the current cursor in bits.
func (w *BitWriter) Pos() int64 { return w.pos }

// Mark records the current cursor for a later Rollback.
func (w *BitWriter) Mark() int64 { return w.pos }

// Rollback returns the cursor to a previous Mark. Bits past the mark are
// discarded logically and will be overwritten by subsequent writes.
func (w *BitWriter) Rollback(mark int64) {
	if mark < 0 || mark > w.pos {
		return
	}
	w.pos = mark
}

func (w *BitWriter) setBit(p int64, b uint64) {
	idx := p >> 3
	for int64(len(w.buf)) <= idx {
		w.buf = append(w.buf, 0)
	}
	var mask byte
	if w.order == MSBFirst {
		mask = 1 << (7 - uint(p&7))
	} else {
		mask = 1 << uint(p&7)
	}
	w.buf[idx] &^= mask
	if b != 0 {
		w.buf[idx] |= mask
	}
}

// WriteBits writes the low n bits of value. If value does not fit in n bits
// the write is rejected with ErrOverflow and the cursor does not advance.
func (w *BitWriter) WriteBits(value uint64, n int) error {
	if n < 0 || n > 64 {
		return ErrInvalid
	}
	if n < 64 && n > 0 && value>>uint(n) != 0 {
		return ErrOverflow
	}
	if n == 0 {
		if value != 0 {
			return ErrOverflow
		}
		return nil
	}
	for k := 0; k < n; k++ {
		var bit uint64
		if w.order == MSBFirst {
			bit = (value >> uint(n-1-k)) & 1
		} else {
			bit = (value >> uint(k)) & 1
		}
		w.setBit(w.pos+int64(k), bit)
	}
	w.pos += int64(n)
	return nil
}

// WriteSigned writes v as an n-bit two's-complement integer. Out-of-range
// values are rejected with ErrOverflow and the cursor does not advance.
func (w *BitWriter) WriteSigned(v int64, n int) error {
	if n < 1 || n > 64 {
		return ErrInvalid
	}
	if n < 64 {
		min := -(int64(1) << uint(n-1))
		max := (int64(1) << uint(n-1)) - 1
		if v < min || v > max {
			return ErrOverflow
		}
	}
	return w.WriteBits(uint64(v)&mask64(n), n)
}

// Align pads the stream with zero bits to the next byte boundary and
// returns the number of padding bits written.
func (w *BitWriter) Align() int {
	pad := int((8 - w.pos&7) & 7)
	if pad > 0 {
		_ = w.WriteBits(0, pad)
	}
	return pad
}

// WriteUvarint writes v using unsigned LEB128 (minimal by construction).
func (w *BitWriter) WriteUvarint(v uint64) error {
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			b |= 0x80
		}
		if err := w.WriteBits(uint64(b), 8); err != nil {
			return err
		}
		if v == 0 {
			return nil
		}
	}
}

// WriteVarint writes v as a zigzag-encoded LEB128 signed varint.
func (w *BitWriter) WriteVarint(v int64) error {
	uv := uint64(v)<<1 ^ uint64(v>>63)
	return w.WriteUvarint(uv)
}

// Bytes returns the encoded bytes up to the current cursor. The final byte
// is zero-padded if the cursor is not byte-aligned.
func (w *BitWriter) Bytes() []byte {
	n := int((w.pos + 7) >> 3)
	out := make([]byte, n)
	copy(out, w.buf[:n])
	return out
}

// BitLen returns the total number of bits written.
func (w *BitWriter) BitLen() int64 { return w.pos }

func mask64(n int) uint64 {
	if n >= 64 {
		return ^uint64(0)
	}
	return (uint64(1) << uint(n)) - 1
}
