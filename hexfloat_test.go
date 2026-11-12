package dataeng

import (
	"encoding/binary"
	"errors"
	"math/big"
	"math/rand"
	"testing"
)

func TestDecodeKnownValues(t *testing.T) {
	tests := []struct {
		name string
		word uint32
		want Result
	}{
		{"positive zero", 0x00000000, Result{Bits: 0x00000000, Exact: true}},
		{"negative zero", 0x80000000, Result{Bits: 0x80000000, Exact: true}},
		{"zero ignores exponent", 0x7f000000, Result{Bits: 0x00000000, Exact: true}},
		{"negative zero ignores exponent", 0xff000000, Result{Bits: 0x80000000, Exact: true}},
		{"one", 0x41100000, Result{Bits: 0x3f800000, Exact: true}},
		{"minus one", 0xc1100000, Result{Bits: 0xbf800000, Exact: true}},
		{"one half", 0x40800000, Result{Bits: 0x3f000000, Exact: true}},
		{"eight", 0x41800000, Result{Bits: 0x41000000, Exact: true}},
		{"one sixteenth", 0x40100000, Result{Bits: 0x3d800000, Exact: true}},
		{"minimum nonzero underflows to zero", 0x00000001, Result{Bits: 0x00000000, Underflow: true}},
		{"negative minimum nonzero underflows to zero", 0x80000001, Result{Bits: 0x80000000, Underflow: true}},
		{"minimum binary32 subnormal", 0x20000008, Result{Bits: 0x00000001, Exact: true}},
		{"half minimum subnormal tie to even zero", 0x20000004, Result{Bits: 0x00000000, Underflow: true}},
		{"one and a half subnormal units", 0x2000000c, Result{Bits: 0x00000002, Underflow: true}},
		{"two and a half subnormal units", 0x20000014, Result{Bits: 0x00000002, Underflow: true}},
		{"three and a half subnormal units", 0x2000001c, Result{Bits: 0x00000004, Underflow: true}},
		{"three subnormal units exactly", 0x20000018, Result{Bits: 0x00000003, Exact: true}},
		{"minimum subnormal via another exponent", 0x1f000080, Result{Bits: 0x00000001, Exact: true}},
		{"largest exactly representable subnormal below boundary", 0x213fffff, Result{Bits: 0x007ffffe, Exact: true}},
		{"minimum normal", 0x21400000, Result{Bits: 0x00800000, Exact: true}},
		{"first normal above minimum", 0x21400001, Result{Bits: 0x00800002, Exact: true}},
		{"largest finite binary32", 0x60ffffff, Result{Bits: 0x7f7fffff, Exact: true}},
		{"closest word below largest finite", 0x610fffff, Result{Bits: 0x7f7ffff0, Exact: true}},
		{"last finite exponent with smallest mantissa", 0x65000001, Result{Bits: 0x7d800000, Exact: true}},
		{"smallest overflowing power", 0x66000001, Result{Bits: 0x7f800000, Overflow: true}},
		{"negative smallest overflowing power", 0xe6000001, Result{Bits: 0xff800000, Overflow: true}},
		{"maximum exponent word", 0x7f000001, Result{Bits: 0x7f800000, Overflow: true}},
		{"maximum magnitude word", 0x7fffffff, Result{Bits: 0x7f800000, Overflow: true}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := HexWordToBinary32(test.word); got != test.want {
				t.Fatalf("HexWordToBinary32(%#08x) = %+v, want %+v", test.word, got, test.want)
			}
		})
	}
}

func TestDecodeEqualNonNormalizedWords(t *testing.T) {
	tests := []struct {
		name  string
		words []uint32
		bits  uint32
	}{
		{
			name: "minimum subnormal",
			words: []uint32{
				0x20000008,
				0x1f000080,
				0x1e000800,
				0x1d008000,
				0x1c080000,
				0x1b800000,
			},
			bits: 0x00000001,
		},
		{
			name: "minimum normal",
			words: []uint32{
				0x21400000,
				0x22040000,
				0x23004000,
				0x24000400,
				0x25000040,
				0x26000004,
			},
			bits: 0x00800000,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			for _, word := range test.words {
				got := HexWordToBinary32(word)
				want := Result{Bits: test.bits, Exact: true}
				if got != want {
					t.Fatalf("HexWordToBinary32(%#08x) = %+v, want %+v", word, got, want)
				}
			}
		})
	}
}

func TestDecodeStatusDefinitions(t *testing.T) {
	const minimumNormal = 0x21400000
	const exactSubnormal = 0x20000008
	const inexactSubnormal = 0x20000005
	const overflow = 0x66000000 | 1

	if got := HexWordToBinary32(exactSubnormal); !got.Exact || got.Underflow {
		t.Fatalf("exact subnormal status = %+v, want exact and not underflow", got)
	}
	if got := HexWordToBinary32(inexactSubnormal); got.Exact || !got.Underflow || got.Overflow {
		t.Fatalf("inexact subnormal status = %+v, want inexact underflow", got)
	}
	if got := HexWordToBinary32(minimumNormal); !got.Exact || got.Underflow || got.Overflow {
		t.Fatalf("minimum normal status = %+v, want exact normal", got)
	}
	if got := HexWordToBinary32(overflow); got.Exact || got.Underflow || !got.Overflow {
		t.Fatalf("overflow status = %+v, want inexact overflow", got)
	}
}

func TestDecodeBigEndianBytes(t *testing.T) {
	got, err := HexBytesToBinary32([]byte{0x41, 0x10, 0x00, 0x00})
	if err != nil {
		t.Fatalf("HexBytesToBinary32 returned error: %v", err)
	}
	if want := (Result{Bits: 0x3f800000, Exact: true}); got != want {
		t.Fatalf("HexBytesToBinary32 = %+v, want %+v", got, want)
	}

	got, err = DecodeHexBytes([]byte{0xc1, 0x10, 0x00, 0x00})
	if err != nil {
		t.Fatalf("DecodeHexBytes returned error: %v", err)
	}
	if want := (Result{Bits: 0xbf800000, Exact: true}); got != want {
		t.Fatalf("DecodeHexBytes = %+v, want %+v", got, want)
	}

	for _, length := range []int{0, 3, 5} {
		_, err := HexBytesToBinary32(make([]byte, length))
		if !errors.Is(err, ErrWrongInputBytes) {
			t.Fatalf("length %d: error = %v, want ErrWrongInputBytes", length, err)
		}
	}
}

func TestEncodeBigEndianBytes(t *testing.T) {
	got, err := Binary32ToHexBytes(0x3f800000)
	if err != nil {
		t.Fatalf("Binary32ToHexBytes returned error: %v", err)
	}
	want := [4]byte{0x41, 0x10, 0x00, 0x00}
	if got != want {
		t.Fatalf("Binary32ToHexBytes = %v, want %v", got, want)
	}

	_, err = Binary32ToHexBytes(0x7fc00000)
	if !errors.Is(err, ErrNotFinite) {
		t.Fatalf("Binary32ToHexBytes NaN error = %v, want ErrNotFinite", err)
	}
}

func TestEncodeKnownValues(t *testing.T) {
	tests := []struct {
		name string
		bits uint32
		word uint32
	}{
		{"positive zero", 0x00000000, 0x00000000},
		{"negative zero", 0x80000000, 0x80000000},
		{"one", 0x3f800000, 0x41100000},
		{"minus one", 0xbf800000, 0xc1100000},
		{"one half", 0x3f000000, 0x40800000},
		{"minimum subnormal", 0x00000001, 0x1b800000},
		{"two minimum subnormals exact", 0x00000002, 0x1c100000},
		{"three minimum subnormals exact", 0x00000003, 0x1c180000},
		{"largest subnormal tie to minimum normal", 0x007fffff, 0x21400000},
		{"second largest subnormal exact", 0x007ffffe, 0x213fffff},
		{"minimum normal", 0x00800000, 0x21400000},
		{"first normal half-ULP tie down to even", 0x00800001, 0x21400000},
		{"second value above minimum normal", 0x00800002, 0x21400001},
		{"largest finite binary32", 0x7f7fffff, 0x60ffffff},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := Binary32ToHexWord(test.bits)
			if err != nil {
				t.Fatalf("Binary32ToHexWord(%#08x) returned error: %v", test.bits, err)
			}
			if got != test.word {
				t.Fatalf("Binary32ToHexWord(%#08x) = %#08x, want %#08x", test.bits, got, test.word)
			}
		})
	}
}

func TestEncodeRejectsNonFinite(t *testing.T) {
	for _, bits := range []uint32{0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 0xffffffff} {
		_, err := Binary32ToHexWord(bits)
		if !errors.Is(err, ErrNotFinite) {
			t.Fatalf("Binary32ToHexWord(%#08x): error = %v, want ErrNotFinite", bits, err)
		}
	}
}

func TestDecodeAgainstRationalReference(t *testing.T) {
	words := make([]uint32, 0, 3000)
	for exponent := 0; exponent <= 127; exponent++ {
		for _, mantissa := range []uint32{1, 2, 8, 0x0fffff, 0x100000, 0x800000, 0xffffff} {
			word := uint32(exponent)<<24 | mantissa
			words = append(words, word, word|0x80000000)
		}
	}

	rng := rand.New(rand.NewSource(0x0256))
	for range 1000 {
		words = append(words, rng.Uint32())
	}

	for _, word := range words {
		got := HexWordToBinary32(word)
		want := referenceDecode(t, word)
		if got != want {
			t.Fatalf("word %#08x: got %+v, rational reference %+v", word, got, want)
		}
	}
}

func TestEncodeAgainstRationalReference(t *testing.T) {
	bitPatterns := []uint32{
		0x00000000, 0x80000000,
		0x00000001, 0x00000002, 0x00000003,
		0x003fffff, 0x00400000, 0x007ffffe, 0x007fffff,
		0x00800000, 0x00800001, 0x00800002,
		0x00ffffff, 0x01000000,
		0x3f000000, 0x3f800000, 0x40000000,
		0x7f000000, 0x7f7ffffe, 0x7f7fffff,
		0x80800000, 0xff7fffff,
	}
	for _, exponentField := range []uint32{0, 1, 2, 126, 127, 128, 253, 254} {
		for _, fraction := range []uint32{1, 0x3fffff, 0x400000, 0x7ffffe, 0x7fffff} {
			bitPatterns = append(bitPatterns, exponentField<<23|fraction)
		}
	}

	rng := rand.New(rand.NewSource(0x7f7fffff))
	for range 500 {
		bits := rng.Uint32()
		if (bits>>23)&0xff != 0xff {
			bitPatterns = append(bitPatterns, bits)
		}
	}

	for _, bits := range bitPatterns {
		got, err := Binary32ToHexWord(bits)
		if err != nil {
			t.Fatalf("Binary32ToHexWord(%#08x) returned error: %v", bits, err)
		}
		want := referenceEncode(t, bits)
		if got != want {
			t.Fatalf("binary32 %#08x: got word %#08x, rational reference %#08x", bits, got, want)
		}
	}
}

func referenceDecode(t *testing.T, word uint32) Result {
	t.Helper()

	sign := word & 0x80000000
	mantissa := word & 0x00ffffff
	if mantissa == 0 {
		return Result{Bits: sign, Exact: true}
	}

	magnitude := wordMagnitude(word)
	binaryExponent := floorLog2Rat(t, magnitude)

	if binaryExponent < -126 {
		scaled := multiplyRatByPowerOfTwo(magnitude, 149)
		rounded, exact := roundRatToInteger(t, scaled)
		var bits uint32
		switch {
		case rounded.Sign() == 0:
			bits = sign
		case rounded.Cmp(big.NewInt(1<<23)) >= 0:
			bits = sign | 1<<23
		default:
			bits = sign | uint32(rounded.Uint64())
		}
		return Result{Bits: bits, Exact: exact, Underflow: !exact}
	}

	if binaryExponent > 127 {
		return Result{Bits: sign | 0x7f800000, Overflow: true}
	}

	scaled := multiplyRatByPowerOfTwo(magnitude, -(binaryExponent - 23))
	significand, exact := roundRatToInteger(t, scaled)
	if significand.Cmp(big.NewInt(1<<24)) == 0 {
		binaryExponent++
		significand.SetInt64(1 << 23)
		exact = false
	}
	if binaryExponent > 127 {
		return Result{Bits: sign | 0x7f800000, Overflow: true}
	}

	exponentField := uint32(binaryExponent + 127)
	fraction := uint32FromBigInt(significand) - 1<<23
	return Result{Bits: sign | exponentField<<23 | fraction, Exact: exact}
}

func referenceEncode(t *testing.T, bitPattern uint32) uint32 {
	t.Helper()

	exponentField := (bitPattern >> 23) & 0xff
	if exponentField == 0xff {
		t.Fatalf("referenceEncode called with non-finite bits %#08x", bitPattern)
	}
	sign := bitPattern & 0x80000000
	if exponentField == 0 && bitPattern&0x007fffff == 0 {
		return sign
	}

	magnitude := binary32Magnitude(t, bitPattern)
	var bestDistance *big.Rat
	var bestMantissa uint32
	var bestExponent int
	for exponent := 0; exponent <= 127; exponent++ {
		quantum := powerOfTwoRat(4*exponent - 280)
		ratio := new(big.Rat).Quo(magnitude, quantum)
		mantissaValue, _ := roundRatToInteger(t, ratio)
		mantissa := uint32FromUint64(mantissaValue.Uint64())

		minimum := uint32(0)
		if exponent > 0 {
			minimum = 0x00100000
		}
		const maximum = uint32(0x00ffffff)
		if mantissa < minimum {
			mantissa = minimum
		}
		if mantissa > maximum {
			mantissa = maximum
		}

		candidate := new(big.Rat).Mul(
			new(big.Rat).SetInt(new(big.Int).SetUint64(uint64(mantissa))),
			quantum,
		)
		distance := absoluteRat(new(big.Rat).Sub(magnitude, candidate))

		better := bestDistance == nil
		if bestDistance != nil {
			switch compared := distance.Cmp(bestDistance); {
			case compared < 0:
				better = true
			case compared == 0 && mantissa&1 == 0 && bestMantissa&1 != 0:
				better = true
			case compared == 0 && mantissa&1 == bestMantissa&1 && exponent < bestExponent:
				better = true
			}
		}
		if better {
			bestDistance = distance
			bestMantissa = mantissa
			bestExponent = exponent
		}
	}

	return sign | uint32(bestExponent)<<24 | bestMantissa
}

func wordMagnitude(word uint32) *big.Rat {
	mantissa := word & 0x00ffffff
	exponent := int((word >> 24) & 0x7f)
	value := new(big.Rat).SetInt(new(big.Int).SetUint64(uint64(mantissa)))
	return multiplyRatByPowerOfTwo(value, 4*exponent-280)
}

func binary32Magnitude(t *testing.T, bitPattern uint32) *big.Rat {
	t.Helper()

	exponentField := (bitPattern >> 23) & 0xff
	fraction := bitPattern & 0x007fffff
	var significand uint32
	var exponent int
	if exponentField == 0 {
		significand = fraction
		exponent = -149
	} else {
		significand = 1<<23 | fraction
		exponent = int(exponentField) - 150
	}
	value := new(big.Rat).SetInt(new(big.Int).SetUint64(uint64(significand)))
	return multiplyRatByPowerOfTwo(value, exponent)
}

func multiplyRatByPowerOfTwo(value *big.Rat, exponent int) *big.Rat {
	return new(big.Rat).Mul(value, powerOfTwoRat(exponent))
}

func powerOfTwoRat(exponent int) *big.Rat {
	if exponent >= 0 {
		numerator := new(big.Int).Lsh(big.NewInt(1), uint(exponent))
		return new(big.Rat).SetInt(numerator)
	}
	denominator := new(big.Int).Lsh(big.NewInt(1), uint(-exponent))
	return new(big.Rat).SetFrac(big.NewInt(1), denominator)
}

func floorLog2Rat(t *testing.T, value *big.Rat) int {
	t.Helper()

	exponent := value.Num().BitLen() - value.Denom().BitLen()
	if compareRatToPowerOfTwo(value, exponent) < 0 {
		exponent--
	}
	if compareRatToPowerOfTwo(value, exponent+1) >= 0 {
		exponent++
	}
	return exponent
}

func compareRatToPowerOfTwo(value *big.Rat, exponent int) int {
	numerator := new(big.Int).Set(value.Num())
	denominator := new(big.Int).Set(value.Denom())
	if exponent >= 0 {
		denominator.Lsh(denominator, uint(exponent))
	} else {
		numerator.Lsh(numerator, uint(-exponent))
	}
	return numerator.Cmp(denominator)
}

func roundRatToInteger(t *testing.T, value *big.Rat) (*big.Int, bool) {
	t.Helper()

	quotient := new(big.Int)
	remainder := new(big.Int)
	quotient.QuoRem(value.Num(), value.Denom(), remainder)

	twiceRemainder := new(big.Int).Lsh(remainder, 1)
	switch compared := twiceRemainder.Cmp(value.Denom()); {
	case compared > 0:
		quotient.Add(quotient, big.NewInt(1))
	case compared == 0 && quotient.Bit(0) == 1:
		quotient.Add(quotient, big.NewInt(1))
	}
	return quotient, remainder.Sign() == 0
}

func absoluteRat(value *big.Rat) *big.Rat {
	result := new(big.Rat).Set(value)
	if result.Sign() < 0 {
		result.Neg(result)
	}
	return result
}

func uint32FromBigInt(value *big.Int) uint32 {
	return uint32(value.Uint64())
}

func uint32FromUint64(value uint64) uint32 {
	return uint32(value)
}

func TestDecodeBytesAliasesBigEndian(t *testing.T) {
	src := make([]byte, 4)
	binary.BigEndian.PutUint32(src, 0x41100000)
	got, err := HexBytesToBinary32(src)
	if err != nil {
		t.Fatalf("HexBytesToBinary32 returned error: %v", err)
	}
	if got.Bits != 0x3f800000 || !got.Exact {
		t.Fatalf("big-endian decode = %+v, want one", got)
	}
}
