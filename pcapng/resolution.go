package pcapng

import (
	"errors"
	"math/big"
)

// Resolution decodes an interface if_tsresol value.
//
// If Binary is false the timestamp unit is 10^-Exponent seconds (decimal).
// If Binary is true the unit is 2^-Exponent seconds (binary).
type Resolution struct {
	Binary   bool
	Exponent uint
}

// defaultResolution is the pcapng default when no if_tsresol option exists:
// 10^-6 seconds, i.e. microsecond resolution.
func defaultResolution() Resolution {
	return Resolution{Binary: false, Exponent: 6}
}

// parseResolution decodes the single-byte if_tsresol option. The most
// significant bit selects the base; the remaining seven bits are the exponent.
func parseResolution(b byte) (Resolution, error) {
	r := Resolution{
		Binary:   b&0x80 != 0,
		Exponent: uint(b & 0x7F),
	}
	switch {
	case r.Exponent == 0:
		// A zero exponent means one-second units, which is legal.
	case !r.Binary && r.Exponent > 9:
		return Resolution{}, errors.New("pcapng: decimal timestamp exponent must be in [0,9]")
	case r.Binary && r.Exponent > 63:
		return Resolution{}, errors.New("pcapng: binary timestamp exponent must be in [0,63]")
	}
	return r, nil
}

// String renders the resolution as its timestamp unit, for example "10^-6 s"
// or "2^-23 s".
func (r Resolution) String() string {
	base := "10"
	if r.Binary {
		base = "2"
	}
	return base + "^-" + itoa(r.Exponent) + " s"
}

// toRat converts a raw timestamp into exact rational seconds.
func (r Resolution) toRat(raw uint64) *big.Rat {
	if r.Exponent == 0 {
		return new(big.Rat).SetUint64(raw)
	}
	num := new(big.Int).SetUint64(raw)
	den := new(big.Int)
	if r.Binary {
		den.Lsh(big.NewInt(1), r.Exponent)
	} else {
		den.Exp(big.NewInt(10), big.NewInt(int64(r.Exponent)), nil)
	}
	return new(big.Rat).SetFrac(num, den)
}

func itoa(n uint) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
