package dataeng

import (
	"errors"
	"fmt"
	"math"
)

// Kind identifies the encoding of a Segment.
type Kind int

const (
	// RunKind is a run-length segment: Count copies of Value.
	RunKind Kind = iota
	// LiteralKind is a packed bitmap segment: ValidBits bits stored
	// low-bit-first in Bits.
	LiteralKind
)

// Segment is one encoded fragment of a boolean column.
//
// For RunKind, Value and Count are used. For LiteralKind, Bits holds the
// packed bits (bit i is Bits[i/8]>>(i%8)&1) and ValidBits is the number of
// meaningful bits; len(Bits) must equal ceil(ValidBits/8) and any bits
// beyond ValidBits in the final byte must be zero.
type Segment struct {
	Kind      Kind
	Value     bool
	Count     uint64
	Bits      []byte
	ValidBits uint64
}

// Run returns a run-length segment of count copies of value.
func Run(value bool, count uint64) Segment {
	return Segment{Kind: RunKind, Value: value, Count: count}
}

// Literal returns a bitmap segment of validBits bits packed low-bit-first
// in bits.
func Literal(bits []byte, validBits uint64) Segment {
	return Segment{Kind: LiteralKind, Bits: bits, ValidBits: validBits}
}

// ErrLengthOverflow is returned when the total row count of a stream
// exceeds the representable range of uint64.
var ErrLengthOverflow = errors.New("dataeng: total length overflows uint64")

// length validates the segment and returns its row count.
func (s Segment) length() (uint64, error) {
	switch s.Kind {
	case RunKind:
		return s.Count, nil
	case LiteralKind:
		full := s.ValidBits / 8
		rem := s.ValidBits % 8
		want := full
		if rem != 0 {
			want++
		}
		if uint64(len(s.Bits)) != want {
			return 0, fmt.Errorf("literal with %d valid bits needs %d bytes, got %d", s.ValidBits, want, len(s.Bits))
		}
		if rem != 0 && s.Bits[len(s.Bits)-1]>>rem != 0 {
			return 0, fmt.Errorf("literal has non-zero bits beyond %d valid bits", s.ValidBits)
		}
		return s.ValidBits, nil
	default:
		return 0, fmt.Errorf("unknown segment kind %d", int(s.Kind))
	}
}

// validateStream checks every segment and returns the total row count,
// rejecting length overflow.
func validateStream(segs []Segment) (uint64, error) {
	var total uint64
	for i, seg := range segs {
		n, err := seg.length()
		if err != nil {
			return 0, fmt.Errorf("segment %d: %w", i, err)
		}
		if total > math.MaxUint64-n {
			return 0, ErrLengthOverflow
		}
		total += n
	}
	return total, nil
}

// bitAt reports the value of the bit at offset off within a literal segment.
func (s Segment) bitAt(off uint64) bool {
	return s.Bits[off/8]>>(off%8)&1 == 1
}

// runFrom returns the value at offset off within a literal segment and the
// length of the equal-value run starting there (bounded by ValidBits).
func (s Segment) runFrom(off uint64) (bool, uint64) {
	v := s.bitAt(off)
	n := uint64(1)
	for off+n < s.ValidBits && s.bitAt(off+n) == v {
		n++
	}
	return v, n
}
