package wasmcheck

import (
	"errors"
	"unicode/utf8"
)

var (
	errLEBTruncated  = errors.New("wasmcheck: truncated LEB128 integer")
	errLEBOverflow   = errors.New("wasmcheck: LEB128 integer overflows 32 bits")
	errUnexpectedEOF = errors.New("wasmcheck: unexpected end of section")
	errMalformed     = errors.New("wasmcheck: malformed section payload")
)

// reader is a bounds-checked byte cursor scoped to one section payload.
// It never reads past the end of its backing slice, so a declared section
// length cannot cause reads to bleed into the next section.
type reader struct {
	buf []byte
	pos int
}

func (r *reader) remaining() int {
	return len(r.buf) - r.pos
}

func (r *reader) readByte() (byte, error) {
	if r.pos >= len(r.buf) {
		return 0, errUnexpectedEOF
	}
	b := r.buf[r.pos]
	r.pos++
	return b, nil
}

// u32 decodes an unsigned LEB128 value and rejects truncation and any
// encoding that does not canonically fit in 32 bits.
func (r *reader) u32() (uint32, error) {
	var result uint64
	var shift uint
	for i := 0; i < 5; i++ {
		if r.pos >= len(r.buf) {
			return 0, errLEBTruncated
		}
		b := r.buf[r.pos]
		r.pos++
		if i == 4 {
			// A fifth byte may only carry the top 4 payload bits and must
			// terminate the sequence.
			if b&0xf0 != 0 {
				return 0, errLEBOverflow
			}
		}
		result |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			if result > 0xffffffff {
				return 0, errLEBOverflow
			}
			return uint32(result), nil
		}
		shift += 7
	}
	return 0, errLEBOverflow
}

// s32 decodes a signed LEB128 value and rejects truncation, overlong
// sequences and non-canonical sign extension.
func (r *reader) s32() (int32, error) {
	var result uint32
	var shift uint
	for i := 0; i < 5; i++ {
		if r.pos >= len(r.buf) {
			return 0, errLEBTruncated
		}
		b := r.buf[r.pos]
		r.pos++
		if i == 4 {
			if b&0x80 != 0 {
				return 0, errLEBOverflow
			}
			// The final group only contributes four payload bits. Bit 3 is
			// the sign bit and the upper three bits (mask 0x70) must be a
			// canonical extension of it: all zero for a positive value, all
			// one for a negative value. Everything else overflows 32 bits.
			switch b & 0x70 {
			case 0x00, 0x70:
			default:
				return 0, errLEBOverflow
			}
		}
		result |= uint32(b&0x7f) << shift
		if b&0x80 == 0 {
			signBit := byte(0x40)
			if i == 4 {
				signBit = 0x08
			}
			// Extend the sign into the undecoded high bits. The fifth group
			// (shift == 28) places its sign bit directly at bit 31, so its
			// uint32 representation is already the correct two's-complement
			// value and must not be extended by a 32-bit shift.
			if b&signBit != 0 && i < 4 {
				result |= ^uint32(0) << (shift + 7)
			}
			return int32(result), nil
		}
		shift += 7
	}
	return 0, errLEBOverflow
}

// name decodes a UTF-8 length-prefixed name. A zero length is permitted for
// custom section names; callers validate non-emptiness where required.
func (r *reader) name() (string, error) {
	n, err := r.u32()
	if err != nil {
		return "", err
	}
	if uint64(n) > uint64(r.remaining()) {
		return "", errUnexpectedEOF
	}
	raw := r.buf[r.pos : r.pos+int(n)]
	if !utf8.Valid(raw) {
		return "", errMalformed
	}
	r.pos += int(n)
	return string(raw), nil
}

// count decodes a vector length, rejecting counts that cannot possibly fit
// in the bytes left in this section to prevent oversized allocations.
func (r *reader) count() (int, error) {
	n, err := r.u32()
	if err != nil {
		return 0, err
	}
	if uint64(n) > uint64(r.remaining()) {
		return 0, errMalformed
	}
	return int(n), nil
}
