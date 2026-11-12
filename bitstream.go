package dataeng

import "fmt"

// readBits reads n bits starting at bitOff into the payload.  Bit zero is the
// most significant bit of payload[0], matching the wire format.
func readBits(payload []byte, bitOff uint64, n uint) (uint64, error) {
	total := uint64(len(payload)) * 8
	if bitOff > total {
		return 0, fmt.Errorf("%w: bit offset %d beyond %d", ErrTruncated, bitOff, total)
	}
	if uint64(n) > total-bitOff {
		return 0, fmt.Errorf("%w: need bits [%d,%d), have [0,%d)",
			ErrTruncated, bitOff, bitOff+uint64(n), total)
	}
	if n == 0 {
		return 0, nil
	}
	if n > 64 {
		return 0, fmt.Errorf("%w: bit width %d exceeds 64", ErrMalformedPayload, n)
	}

	var v uint64
	for i := uint(0); i < n; i++ {
		p := bitOff + uint64(i)
		bit := (payload[p/8] >> (7 - (p % 8))) & 1
		v = (v << 1) | uint64(bit)
	}
	return v, nil
}

func payloadBit(payload []byte, bitOff uint64) (uint64, error) {
	return readBits(payload, bitOff, 1)
}

// bitWriter writes MSB-first and appends bytes lazily.  New bytes start as
// zero, so any unused low bits in the final byte remain zero.
type bitWriter struct {
	buf   []byte
	nbits uint64
}

func (w *bitWriter) write(v uint64, n uint) {
	for i := n; i > 0; i-- {
		if w.nbits%8 == 0 {
			w.buf = append(w.buf, 0)
		}
		if (v>>(i-1))&1 != 0 {
			w.buf[w.nbits/8] |= 1 << (7 - (w.nbits % 8))
		}
		w.nbits++
	}
}
