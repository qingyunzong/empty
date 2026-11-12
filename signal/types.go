// Package signal interprets bit-field signals inside multiplexed telemetry
// frames.
//
// A frame pattern describes one frame ID with a fixed byte length and a set of
// signals. Each signal lists the bit positions it occupies, ordered from the
// least significant assembled integer bit to the most significant one. Bit
// positions are global within the frame: bit number = byte index * 8 +
// low-numbered bit offset inside the byte, both zero based.
//
// Signals may be gated by an unsigned selector signal: a gated signal is only
// present when that selector's raw integer equals the required value.
// Selectors themselves are always active and may never depend on another
// selector.
package signal

import "math/big"

// Bit is one frame bit position. Index is the zero-based byte index inside the
// frame and InByte is the zero-based low-numbered bit offset inside that byte.
// The global bit number is Index*8 + InByte.
type Bit struct {
	Index  int
	InByte uint
}

// Position returns the global bit number Index*8 + InByte.
func (b Bit) Position() int {
	return b.Index*8 + int(b.InByte)
}

// Rational is an exact rational value expressed as numerator over denominator.
// A zero denominator is invalid.
type Rational struct {
	Num int64
	Den int64
}

// Rat returns the value as a reduced *big.Rat.
func (r Rational) Rat() (*big.Rat, error) {
	if r.Den == 0 {
		return nil, ErrRational
	}
	return big.NewRat(r.Num, r.Den), nil
}

// Signal describes one bit-field signal in a frame pattern.
//
// Bits are ordered from the least significant assembled integer bit to the
// most significant one. When Selector is empty the signal is unconditionally
// active. Otherwise the signal is active only when the unsigned selector named
// by Selector has raw value Equals.
type Signal struct {
	Name     string
	Bits     []Bit
	Signed   bool
	Scale    Rational
	Offset   Rational
	Selector string
	Equals   uint64
}

// BitSource records the frame origin of one assembled integer bit.
type BitSource struct {
	// AssembledBit is the zero-based position in the assembled integer,
	// 0 being the least significant bit.
	AssembledBit uint
	// ByteIndex is the frame byte the bit was read from.
	ByteIndex int
	// BitInByte is the low-numbered bit offset inside that byte.
	BitInByte uint
}

// DecodedSignal is one decoded active signal.
type DecodedSignal struct {
	Name     string
	Raw      *big.Int
	Value    *big.Rat
	Selector string
	Sources  []BitSource
}

// DecodedFrame contains every signal activated by the frame's selectors.
type DecodedFrame struct {
	FrameID uint32
	Signals []DecodedSignal
}
