package telemetry

// varintGroups is the maximum number of 7-bit groups a uint64 needs.
const varintGroups = 10

// WriteVarint appends v as a base-128 varint: 7 payload bits per group
// followed by a continuation bit, least significant group first. Each
// group respects the writer's bit order.
func (w *Writer) WriteVarint(v uint64) error {
	for v >= 0x80 {
		if err := w.WriteBits(v&0x7f, 7); err != nil {
			return err
		}
		w.WriteBit(1)
		v >>= 7
	}
	if err := w.WriteBits(v, 7); err != nil {
		return err
	}
	w.WriteBit(0)
	return nil
}

// WriteVarintSigned appends s zigzag-encoded as a varint.
func (w *Writer) WriteVarintSigned(s int64) error {
	return w.WriteVarint(uint64((s << 1) ^ (s >> 63)))
}

// ReadVarint consumes a base-128 varint. Overlong encodings (a shorter
// form exists) and encodings overflowing 64 bits are rejected; on any
// error the cursor is restored to where the read started.
func (r *Reader) ReadVarint() (uint64, error) {
	mark := r.pos
	fail := func(err error) (uint64, error) {
		r.pos = mark
		return 0, err
	}
	var v uint64
	for i := 0; i < varintGroups; i++ {
		if err := r.ensure(8); err != nil {
			return fail(err)
		}
		g, _ := r.ReadBits(7)
		c, _ := r.ReadBit()
		if i == varintGroups-1 {
			if c != 0 {
				return fail(ErrOverflow) // would need an 11th group
			}
			if g > 1 {
				return fail(ErrOverflow) // bits beyond bit 63
			}
			if g == 0 {
				return fail(ErrOverlong)
			}
			return v | g<<63, nil
		}
		v |= g << uint(7*i)
		if c == 0 {
			if i > 0 && g == 0 {
				return fail(ErrOverlong)
			}
			return v, nil
		}
	}
	panic("telemetry: unreachable")
}

// ReadVarintSigned consumes a zigzag-encoded varint. On error the cursor
// is restored to where the read started.
func (r *Reader) ReadVarintSigned() (int64, error) {
	u, err := r.ReadVarint()
	if err != nil {
		return 0, err
	}
	return int64(u>>1) ^ -int64(u&1), nil
}
