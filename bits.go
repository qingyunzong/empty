package dataeng

import (
	"fmt"
	"strings"
)

// BitString is an immutable MSB-first bit buffer. Its zero value is a valid
// empty stream.
type BitString struct {
	data   []byte
	length int
}

// NewBitString builds a bit stream from a contiguous string containing only
// '0' and '1'. Whitespace is intentionally not accepted, making host input
// mistakes visible.
func NewBitString(s string) (BitString, error) {
	if strings.IndexFunc(s, func(r rune) bool { return r != '0' && r != '1' }) >= 0 {
		return BitString{}, fmt.Errorf("%w: bit string contains a byte other than 0 or 1", ErrInvalidBits)
	}
	data := make([]byte, (len(s)+7)/8)
	for i := range s {
		if s[i] == '1' {
			data[i/8] |= 1 << uint(7-i%8)
		}
	}
	return BitString{data: data, length: len(s)}, nil
}

// NewBitStringBytes builds a bit stream from MSB-first packed bytes. bitLength
// selects how many leading bits are part of the stream; it may be smaller than
// 8*len(data), in which case trailing byte bits are ignored.
func NewBitStringBytes(data []byte, bitLength int) (BitString, error) {
	if bitLength < 0 || bitLength > len(data)*8 {
		return BitString{}, fmt.Errorf("%w: bit length %d does not fit %d bytes", ErrInvalidBits, bitLength, len(data))
	}
	owned := append([]byte(nil), data...)
	return BitString{data: owned, length: bitLength}, nil
}

// Len returns the number of bits in the stream.
func (b BitString) Len() int {
	return b.length
}
