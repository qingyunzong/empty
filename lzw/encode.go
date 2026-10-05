package lzw

const (
	tableSize    = 4 * 1 << maxWidth
	tableMask    = tableSize - 1
	invalidEntry = 0
)

type bitWriter struct {
	buf   []byte
	bits  uint32
	nBits uint
	width uint
}

func (w *bitWriter) write(code uint32) {
	w.bits |= code << w.nBits
	w.nBits += w.width
	for w.nBits >= 8 {
		w.buf = append(w.buf, byte(w.bits))
		w.bits >>= 8
		w.nBits -= 8
	}
}

func (w *bitWriter) flush() {
	if w.nBits > 0 {
		w.buf = append(w.buf, byte(w.bits))
		w.bits = 0
		w.nBits = 0
	}
}

// Encode compresses src into an LZW stream. The stream starts with a
// clear code, grows its code width as the dictionary fills, emits a clear
// code when the dictionary is full, and ends with an EOF code.
func Encode(src []byte) []byte {
	w := &bitWriter{width: LitWidth + 1}
	hi, overflow := uint32(EOFCode), uint32(1<<(LitWidth+1))
	var table [tableSize]uint32
	reset := func() {
		w.width = LitWidth + 1
		hi = EOFCode
		overflow = 1 << (LitWidth + 1)
		for i := range table {
			table[i] = invalidEntry
		}
	}
	incHi := func() (outOfCodes bool) {
		hi++
		if hi == overflow {
			w.width++
			overflow <<= 1
		}
		if hi == maxCode {
			w.write(ClearCode)
			reset()
			return true
		}
		return false
	}
	w.write(ClearCode)
	saved := ^uint32(0)
	if len(src) > 0 {
		saved = uint32(src[0])
		for _, x := range src[1:] {
			lit := uint32(x)
			key := saved<<8 | lit
			hash := (key>>12 ^ key) & tableMask
			found := false
			for {
				t := table[hash]
				if t == invalidEntry {
					break
				}
				if t>>12 == key {
					saved = t & maxCode
					found = true
					break
				}
				hash = (hash + 1) & tableMask
			}
			if found {
				continue
			}
			w.write(saved)
			saved = lit
			if incHi() {
				continue
			}
			table[hash] = key<<12 | hi
		}
	}
	if saved != ^uint32(0) {
		w.write(saved)
		incHi()
	}
	w.write(EOFCode)
	w.flush()
	return w.buf
}
