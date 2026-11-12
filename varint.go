package dataeng

import (
	"errors"
	"fmt"
)

// errNeedMore is an internal control-flow signal, not a caller-visible
// decoding failure.
var errNeedMore = errors.New("dataeng: need more input")

// readULEB decodes an unsigned LEB128 integer of the given bit width. It
// consumes at most (bits+6)/7 bytes and requires the final byte to use only
// the bits that remain in the width. The shortest encoding is mandatory.
func readULEB(buf []byte, pos, bits int) (uint64, int, error) {
	maxBytes := (bits + 6) / 7
	var value uint64

	for i := 0; i < maxBytes; i++ {
		at := pos + i
		if at >= len(buf) {
			return 0, pos, errNeedMore
		}
		b := buf[at]
		payload := uint64(b & 0x7f)
		shift := uint(7 * i)

		if i == maxBytes-1 {
			if b&0x80 != 0 {
				return 0, pos, fmt.Errorf("%w: more than %d bytes", ErrVarintOverflow, maxBytes)
			}
			finalBits := uint(bits - 7*i)
			if finalBits < 7 && payload >= uint64(1)<<finalBits {
				return 0, pos, fmt.Errorf("%w: final byte uses more than %d bits", ErrVarintOverflow, finalBits)
			}
			if i > 0 && payload == 0 {
				return 0, pos, fmt.Errorf("%w: trailing zero group", ErrNonMinimalVarint)
			}
			value |= payload << shift
			return value, at + 1, nil
		}

		value |= payload << shift
		if b&0x80 == 0 {
			if i > 0 && payload == 0 {
				return 0, pos, fmt.Errorf("%w: trailing zero group", ErrNonMinimalVarint)
			}
			return value, at + 1, nil
		}
	}

	// The final iteration always returns, so this line is defensive.
	return 0, pos, fmt.Errorf("%w: more than %d bytes", ErrVarintOverflow, maxBytes)
}

// zigzagDecode maps an unsigned zig-zag value back to its signed integer.
func zigzagDecode(u uint64, bits int) (int64, error) {
	raw := int64(u>>1) ^ -int64(u&1)
	if bits < 64 {
		min := int64(-1) << uint(bits-1)
		max := (int64(1) << uint(bits-1)) - 1
		if raw < min || raw > max {
			return 0, fmt.Errorf("%w: %d does not fit in %d signed bits", ErrValueRange, raw, bits)
		}
	}
	return raw, nil
}
