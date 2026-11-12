package dataeng

import (
	"encoding/binary"
	"errors"
	"math/bits"
)

const (
	hexWordMantissaBits = 24

	binary32MantissaBits    = 23
	binary32ExponentBias    = 127
	binary32MinNormalExp    = -126
	binary32MaxExp          = 127
	binary32MinSubnormalExp = -149

	binary32ExponentMask = 0x7f800000
	binary32FractionMask = 0x007fffff
	hexWordMantissaMask  = 0x00ffffff
)

var (
	ErrNotFinite       = errors.New("dataeng: NaN and infinity have no hexadecimal floating-point representation")
	ErrWrongInputBytes = errors.New("dataeng: hexadecimal floating-point word must contain exactly four bytes")
)

// Result is the raw IEEE binary32 bit pattern produced from one hexadecimal
// floating-point word, together with the conversion status.
//
// Exact reports whether the hexadecimal value is exactly equal to the returned
// binary32 value. Underflow reports a pre-rounding magnitude below the minimum
// binary32 normal (2^-126) for an inexact conversion. Overflow reports that the
// finite hexadecimal value rounded to signed infinity.
type Result struct {
	Bits      uint32
	Exact     bool
	Underflow bool
	Overflow  bool
}

// DecodeResult is an alias for Result.
type DecodeResult = Result

// HexWordToBinary32 converts a packed hexadecimal floating-point word to an
// IEEE binary32 bit pattern.
//
// Bits 31, 30..24, and 23..0 are the sign, seven-bit exponent e, and 24-bit
// integer mantissa m. The exact magnitude is
//
//	m * 2^(4*e-280)
//
// A zero mantissa denotes signed zero regardless of e. Nonzero mantissas need
// not be normalized. Rounding is round-to-nearest, ties-to-even, performed
// directly with integer arithmetic.
func HexWordToBinary32(word uint32) Result {
	sign := word & 0x80000000
	exponent := int((word >> 24) & 0x7f)
	mantissa := word & hexWordMantissaMask

	if mantissa == 0 {
		return Result{Bits: sign, Exact: true}
	}

	leadingBit := bits.Len32(mantissa) - 1
	power := 4*exponent - 280
	binaryExponent := leadingBit + power

	if binaryExponent < binary32MinNormalExp {
		shift := 4*exponent - (280 + binary32MinSubnormalExp)
		var rounded uint32
		var exact bool
		if shift >= 0 {
			rounded = mantissa << uint(shift)
			exact = true
		} else {
			var discarded bool
			rounded, discarded = roundRight(mantissa, uint(-shift))
			exact = !discarded
		}

		if rounded >= 1<<binary32MantissaBits {
			return Result{Bits: sign | 1<<binary32MantissaBits, Exact: exact, Underflow: !exact}
		}
		return Result{Bits: sign | rounded, Exact: exact, Underflow: !exact}
	}

	if binaryExponent > binary32MaxExp {
		return Result{Bits: sign | binary32ExponentMask, Overflow: true}
	}

	significand := mantissa << uint(binary32MantissaBits-leadingBit)
	exponentField := uint32(binaryExponent + binary32ExponentBias)
	bitPattern := sign | exponentField<<binary32MantissaBits | (significand - 1<<binary32MantissaBits)
	return Result{Bits: bitPattern, Exact: true}
}

// DecodeHexWord is an alias for HexWordToBinary32.
func DecodeHexWord(word uint32) Result {
	return HexWordToBinary32(word)
}

// HexBytesToBinary32 decodes a four-byte big-endian hexadecimal word and
// converts it to binary32.
func HexBytesToBinary32(src []byte) (Result, error) {
	if len(src) != 4 {
		return Result{}, ErrWrongInputBytes
	}
	return HexWordToBinary32(binary.BigEndian.Uint32(src)), nil
}

// DecodeHexBytes is an alias for HexBytesToBinary32.
func DecodeHexBytes(src []byte) (Result, error) {
	return HexBytesToBinary32(src)
}

// Binary32ToHexWord converts a finite IEEE binary32 bit pattern to the
// closest normalized hexadecimal floating-point word.
//
// The result uses round-to-nearest, ties-to-even. For nonzero values it chooses
// among representable words with a leading nonzero hexadecimal mantissa digit
// (m >= 0x100000); exponent zero may use a smaller mantissa if normalization
// is impossible. Equal-value ties prefer an even mantissa and then the smaller
// exponent. Signed zero is encoded as exponent zero and mantissa zero.
//
// NaN and infinity cannot be represented and return ErrNotFinite.
func Binary32ToHexWord(bitPattern uint32) (uint32, error) {
	exponentField := (bitPattern >> binary32MantissaBits) & 0xff
	if exponentField == 0xff {
		return 0, ErrNotFinite
	}

	sign := bitPattern & 0x80000000
	fraction := bitPattern & binary32FractionMask
	if exponentField == 0 && fraction == 0 {
		return sign, nil
	}

	var significand uint32
	var binaryExponent int
	if exponentField == 0 {
		significand = fraction
		binaryExponent = binary32MinSubnormalExp
	} else {
		significand = 1<<binary32MantissaBits | fraction
		binaryExponent = int(exponentField) - binary32ExponentBias - binary32MantissaBits
	}

	leadingBit := bits.Len32(significand) - 1
	hexExponent := (binaryExponent + leadingBit + 260) / 4
	mantissaShift := binaryExponent + 280 - 4*hexExponent

	var mantissa uint32
	if mantissaShift >= 0 {
		mantissa = significand << uint(mantissaShift)
	} else {
		mantissa, _ = roundRight(significand, uint(-mantissaShift))
	}

	if mantissa == 1<<hexWordMantissaBits {
		hexExponent++
		mantissa = 1 << 20
	}

	return sign | uint32(hexExponent)<<24 | mantissa, nil
}

// Binary32ToHexBytes converts a finite IEEE binary32 bit pattern to a
// four-byte big-endian hexadecimal floating-point word.
func Binary32ToHexBytes(bitPattern uint32) ([4]byte, error) {
	word, err := Binary32ToHexWord(bitPattern)
	if err != nil {
		return [4]byte{}, err
	}
	var dst [4]byte
	binary.BigEndian.PutUint32(dst[:], word)
	return dst, nil
}

// EncodeHexWord is an alias for Binary32ToHexWord.
func EncodeHexWord(bitPattern uint32) (uint32, error) {
	return Binary32ToHexWord(bitPattern)
}

func roundRight(value uint32, shift uint) (rounded uint32, discarded bool) {
	if shift == 0 {
		return value, false
	}
	if shift >= 32 {
		return 0, value != 0
	}

	quotient := value >> shift
	remainder := value & (1<<shift - 1)
	half := uint32(1) << (shift - 1)
	discarded = remainder != 0
	if remainder > half || remainder == half && quotient&1 == 1 {
		quotient++
	}
	return quotient, discarded
}
