package lzw

// bitWriter packs codes LSB-first into a byte stream.
type bitWriter struct {
	buf   []byte
	acc   uint64
	nbits uint
}

func (w *bitWriter) write(code int, width int) {
	w.acc |= uint64(code) << w.nbits
	w.nbits += uint(width)
	for w.nbits >= 8 {
		w.buf = append(w.buf, byte(w.acc))
		w.acc >>= 8
		w.nbits -= 8
	}
}

// flush pads the final partial byte with zero bits.
func (w *bitWriter) flush() {
	if w.nbits > 0 {
		w.buf = append(w.buf, byte(w.acc))
		w.acc = 0
		w.nbits = 0
	}
}

// bitReader reads codes LSB-first from a byte stream.
type bitReader struct {
	data []byte
	pos  int // bit cursor
}

func (r *bitReader) remaining() int { return len(r.data)*8 - r.pos }

func (r *bitReader) read(width int) (int, bool) {
	if r.remaining() < width {
		return 0, false
	}
	code := 0
	for i := 0; i < width; i++ {
		bitPos := r.pos + i
		if r.data[bitPos/8]>>(uint(bitPos%8))&1 == 1 {
			code |= 1 << uint(i)
		}
	}
	r.pos += width
	return code, true
}

// paddingValue returns the remaining bits (fewer than one byte) as an
// LSB-first value, used to validate zero padding at end of stream.
func (r *bitReader) paddingValue() int {
	n := r.remaining()
	val := 0
	for i := 0; i < n; i++ {
		bitPos := r.pos + i
		if r.data[bitPos/8]>>(uint(bitPos%8))&1 == 1 {
			val |= 1 << uint(i)
		}
	}
	return val
}
