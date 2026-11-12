package dataeng

import (
	"errors"
	"fmt"
	"math/big"
	"strconv"
)

// Class describes the kind of binary64 value named by the input bit pattern.
type Class uint8

const (
	// ClassFinite denotes a finite, non-zero value.
	ClassFinite Class = iota
	// ClassZero denotes either signed zero.
	ClassZero
	// ClassInf denotes either signed infinity.
	ClassInf
	// ClassNaN denotes any NaN, including signaling and quiet NaNs.
	ClassNaN
)

// Interval is the exact, signed round-to-nearest-even interval of real
// numbers that round to a finite binary64 value. Lower and Upper are
// independent rational values; callers may inspect or modify their own copy.
type Interval struct {
	Lower       *big.Rat
	Upper       *big.Rat
	LowerClosed bool
	UpperClosed bool
}

// Contains reports whether x belongs to the interval, including endpoint
// rules. It does not modify x or the interval.
func (iv *Interval) Contains(x *big.Rat) bool {
	if iv == nil || iv.Lower == nil || iv.Upper == nil || x == nil {
		return false
	}
	lowerCmp := x.Cmp(iv.Lower)
	if lowerCmp < 0 || (lowerCmp == 0 && !iv.LowerClosed) {
		return false
	}
	upperCmp := x.Cmp(iv.Upper)
	return upperCmp < 0 || (upperCmp == 0 && iv.UpperClosed)
}

// Result is the canonical decimal certificate for one binary64 bit pattern.
//
// For finite values, C and Q encode Sign*C*10^Q, with C always positive and
// in canonical form. C is nil for infinities and NaNs. Bits is always the
// exact input bit pattern, so NaN payload and sign bits are retained even
// though all NaNs use the text "nan".
type Result struct {
	Bits uint64

	// Sign is +1 or -1 for zeros, finite values, and infinities. It is 0 for
	// NaNs because the text "nan" intentionally does not preserve NaN signs.
	Sign int
	// C is the positive decimal coefficient, or nil for infinities and NaNs.
	C *big.Int
	Q int

	// Text is the canonical scientific-notation representation.
	Text  string
	Class Class

	// RoundTrip is false exactly for NaNs. In particular, the common "nan"
	// text does not recover a NaN's original payload.
	RoundTrip bool
	// NaNPayload holds the low 52 fraction bits for NaNs and is zero
	// otherwise. Bits retains the complete original NaN encoding.
	NaNPayload uint64

	// Interval is the exact signed rounding interval for finite values. It is
	// nil for zeros, infinities, and NaNs. For negative finite values the
	// bounds are ordered normally (Lower < Upper) and already carry the sign.
	Interval *Interval
}

// IsFinite reports whether the result is a finite value, including zero.
func (r Result) IsFinite() bool {
	return r.Class == ClassFinite || r.Class == ClassZero
}

// IsZero reports whether the result is positive or negative zero.
func (r Result) IsZero() bool {
	return r.Class == ClassZero
}

// IsInf reports whether the result is either infinity.
func (r Result) IsInf() bool {
	return r.Class == ClassInf
}

// IsNaN reports whether the result is any NaN.
func (r Result) IsNaN() bool {
	return r.Class == ClassNaN
}

// Coefficient returns an independent copy of C. It returns nil for
// infinities and NaNs.
func (r Result) Coefficient() *big.Int {
	if r.C == nil {
		return nil
	}
	return new(big.Int).Set(r.C)
}

// Tuple returns the sign, coefficient, and decimal exponent. The coefficient
// is copied, so the caller cannot modify the certificate through this method.
func (r Result) Tuple() (sign int, c *big.Int, q int) {
	return r.Sign, r.Coefficient(), r.Q
}

type binaryFormat struct {
	expBits  uint
	fracBits uint
	bias     int
}

var binary64Format = binaryFormat{expBits: 11, fracBits: 52, bias: 1023}

const (
	binary64SignBit    = uint64(1) << 63
	binary64ExpMask    = uint64(0x7ff)
	binary64FracMask   = uint64(1<<52) - 1
	maxCanonicalDigits = 17
	minDecimalExponent = -400
	maxDecimalExponent = 400
)

type searchConfig struct {
	maxDigits int
	qMin      int
	qMax      int
}

var binary64Search = searchConfig{
	maxDigits: maxCanonicalDigits,
	qMin:      minDecimalExponent,
	qMax:      maxDecimalExponent,
}

type internalInterval struct {
	lower       *big.Rat
	upper       *big.Rat
	lowerClosed bool
	upperClosed bool
}

// Format computes the shortest canonical decimal that rounds to the given
// binary64 bit pattern. It never uses floating-point formatting or parsing.
func Format(bits uint64) Result {
	r := Result{
		Bits:      bits,
		Sign:      1,
		Text:      "0e0",
		Class:     ClassZero,
		RoundTrip: true,
	}
	if bits&binary64SignBit != 0 {
		r.Sign = -1
	}

	expField := (bits >> 52) & binary64ExpMask
	fracField := bits & binary64FracMask
	if expField == binary64ExpMask {
		r.C = nil
		r.Q = 0
		r.Interval = nil
		if fracField == 0 {
			r.Class = ClassInf
			r.Text = signedText(r.Sign, "inf")
			return r
		}
		r.Class = ClassNaN
		r.Sign = 0
		r.Text = "nan"
		r.RoundTrip = false
		r.NaNPayload = fracField
		return r
	}

	absBits := bits &^ binary64SignBit
	if absBits == 0 {
		r.C = big.NewInt(0)
		r.Q = 0
		r.Text = signedText(r.Sign, "0e0")
		return r
	}

	r.Class = ClassFinite
	c, q, absIV, err := selectShortest(absBits, binary64Format, binary64Search)
	if err != nil {
		// Every non-zero binary64 value has a 17-digit candidate inside its
		// rounding interval. This panic only indicates an internal invariant
		// failure, not an unbounded user input.
		panic(fmt.Sprintf("dataeng: no canonical decimal for finite bits %#x: %v", bits, err))
	}
	r.C = new(big.Int).Set(c)
	r.Q = q
	r.Text = signedText(r.Sign, decimalText(c, q))
	r.RoundTrip = true
	if r.Sign < 0 {
		r.Interval = negateInterval(absIV)
	} else {
		r.Interval = publicInterval(absIV)
	}
	return r
}

// FormatBits is an explicit-name alias for Format.
func FormatBits(bits uint64) Result {
	return Format(bits)
}

func signedText(sign int, body string) string {
	if sign < 0 {
		return "-" + body
	}
	return body
}

func decimalText(c *big.Int, q int) string {
	digits := c.String()
	exponent := q + len(digits) - 1
	mantissa := digits
	if len(digits) > 1 {
		mantissa = digits[:1] + "." + digits[1:]
	}
	return mantissa + "e" + strconv.Itoa(exponent)
}

func publicInterval(iv internalInterval) *Interval {
	return &Interval{
		Lower:       new(big.Rat).Set(iv.lower),
		Upper:       new(big.Rat).Set(iv.upper),
		LowerClosed: iv.lowerClosed,
		UpperClosed: iv.upperClosed,
	}
}

func negateInterval(iv internalInterval) *Interval {
	return &Interval{
		Lower:       new(big.Rat).Neg(iv.upper),
		Upper:       new(big.Rat).Neg(iv.lower),
		LowerClosed: iv.upperClosed,
		UpperClosed: iv.lowerClosed,
	}
}

func (bf binaryFormat) fracMask() uint64 {
	if bf.fracBits == 0 {
		return 0
	}
	return uint64(1)<<bf.fracBits - 1
}

func (bf binaryFormat) expMask() uint64 {
	if bf.expBits == 0 {
		return 0
	}
	return uint64(1)<<bf.expBits - 1
}

func (bf binaryFormat) maxFiniteBits() uint64 {
	return (bf.expMask()-1)<<bf.fracBits | bf.fracMask()
}

func (bf binaryFormat) decodePositive(bits uint64) (significand *big.Int, exponent int) {
	expField := (bits >> bf.fracBits) & bf.expMask()
	fracField := bits & bf.fracMask()
	if expField == 0 {
		return new(big.Int).SetUint64(fracField), 1 - bf.bias - int(bf.fracBits)
	}
	m := new(big.Int).Lsh(big.NewInt(1), bf.fracBits)
	m.Add(m, new(big.Int).SetUint64(fracField))
	return m, int(expField) - bf.bias - int(bf.fracBits)
}

func (bf binaryFormat) value(bits uint64) *big.Rat {
	m, exponent := bf.decodePositive(bits)
	if exponent >= 0 {
		return new(big.Rat).SetInt(new(big.Int).Lsh(m, uint(exponent)))
	}
	return new(big.Rat).SetFrac(m, new(big.Int).Lsh(big.NewInt(1), uint(-exponent)))
}

func (bf binaryFormat) virtualNextAfterMax() *big.Rat {
	exponent := int(bf.expMask()-1) - bf.bias + 1
	if exponent >= 0 {
		return new(big.Rat).SetInt(new(big.Int).Lsh(big.NewInt(1), uint(exponent)))
	}
	return new(big.Rat).SetFrac(big.NewInt(1), new(big.Int).Lsh(big.NewInt(1), uint(-exponent)))
}

// absRoundingInterval returns the interval of positive reals that round to
// the given positive, finite, non-zero bit pattern. It uses adjacent positive
// bit patterns rather than assuming either neighboring gap is equal.
func (bf binaryFormat) absRoundingInterval(bits uint64) internalInterval {
	v := bf.value(bits)
	prev := new(big.Rat)
	if bits != 1 {
		prev = bf.value(bits - 1)
	}

	next := new(big.Rat)
	if bits == bf.maxFiniteBits() {
		next = bf.virtualNextAfterMax()
	} else {
		next = bf.value(bits + 1)
	}

	lower := new(big.Rat).Add(v, prev)
	lower.Quo(lower, big.NewRat(2, 1))
	upper := new(big.Rat).Add(v, next)
	upper.Quo(upper, big.NewRat(2, 1))

	m, _ := bf.decodePositive(bits)
	even := m.Bit(0) == 0
	return internalInterval{
		lower:       lower,
		upper:       upper,
		lowerClosed: even,
		upperClosed: even && bits != bf.maxFiniteBits(),
	}
}

func pow10(n int) *big.Int {
	if n < 0 {
		panic("dataeng: negative power of ten")
	}
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// decimalExponent returns floor(log10(r)) for r > 0, exactly.
func decimalExponent(r *big.Rat) int {
	numDigits := len(r.Num().String())
	denDigits := len(r.Denom().String())
	e := numDigits - denDigits
	p := pow10(absInt(e))
	var rVsPower int
	if e >= 0 {
		rVsPower = new(big.Int).Set(r.Num()).Cmp(new(big.Int).Mul(r.Denom(), p))
	} else {
		rVsPower = new(big.Int).Mul(r.Num(), p).Cmp(r.Denom())
	}
	if rVsPower < 0 {
		e--
	}
	return e
}

func scaleByPowerOfTen(r *big.Rat, q int) *big.Rat {
	p := new(big.Rat).SetInt(pow10(absInt(q)))
	out := new(big.Rat)
	if q >= 0 {
		out.Quo(r, p)
	} else {
		out.Mul(r, p)
	}
	return out
}

func smallestIntegerAtLeast(r *big.Rat, closed bool) *big.Int {
	floor, remainder := new(big.Int).QuoRem(r.Num(), r.Denom(), new(big.Int))
	if closed && remainder.Sign() == 0 {
		return floor
	}
	return new(big.Int).Add(floor, big.NewInt(1))
}

func largestIntegerAtMost(r *big.Rat, closed bool) *big.Int {
	floor, remainder := new(big.Int).QuoRem(r.Num(), r.Denom(), new(big.Int))
	if !closed && remainder.Sign() == 0 {
		return new(big.Int).Sub(floor, big.NewInt(1))
	}
	return floor
}

func isMultipleOfTen(c *big.Int) bool {
	return new(big.Int).Mod(c, big.NewInt(10)).Sign() == 0
}

func decimalValue(c *big.Int, q int) *big.Rat {
	if q >= 0 {
		return new(big.Rat).SetInt(new(big.Int).Mul(c, pow10(q)))
	}
	return new(big.Rat).SetFrac(c, pow10(-q))
}

type candidate struct {
	c    *big.Int
	q    int
	x    *big.Rat
	dist *big.Rat
}

func makeCandidate(c *big.Int, q int, v *big.Rat) candidate {
	x := decimalValue(c, q)
	dist := new(big.Rat).Sub(x, v)
	dist.Abs(dist)
	return candidate{c: new(big.Int).Set(c), q: q, x: x, dist: dist}
}

// betterCandidate implements the contract's total ordering among candidates
// with the same number of significant digits: closest exact value, then even
// coefficient, then smaller absolute value.
func betterCandidate(a, b candidate) bool {
	if cmp := a.dist.Cmp(b.dist); cmp != 0 {
		return cmp < 0
	}
	aEven := a.c.Bit(0) == 0
	bEven := b.c.Bit(0) == 0
	if aEven != bEven {
		return aEven
	}
	return a.x.Cmp(b.x) < 0
}

func addCandidateSeeds(dst *[]*big.Int, base, lo, hi *big.Int, radius int) {
	bi := new(big.Int)
	for offset := -radius; offset <= radius+1; offset++ {
		c := new(big.Int).Add(base, bi.SetInt64(int64(offset)))
		if c.Cmp(lo) >= 0 && c.Cmp(hi) <= 0 {
			*dst = append(*dst, c)
		}
	}
	for offset := 0; offset <= radius; offset++ {
		c := new(big.Int).Add(lo, bi.SetInt64(int64(offset)))
		if c.Cmp(hi) <= 0 {
			*dst = append(*dst, c)
		}
		c = new(big.Int).Sub(hi, bi.SetInt64(int64(offset)))
		if c.Cmp(lo) >= 0 {
			*dst = append(*dst, c)
		}
	}
}

// bestCandidateForDigits finds the best canonical coefficient of exactly n
// digits across every admissible q. It works with exact integer endpoint
// bounds, so it never enumerates the 10^17 possible coefficients.
func bestCandidateForDigits(v *big.Rat, iv internalInterval, n int, cfg searchConfig) (candidate, bool) {
	dLower := decimalExponent(iv.lower)
	dUpper := decimalExponent(iv.upper)
	// An n-digit coefficient at exponent q spans
	// [10^(q+n-1), 10^(q+n)). For an overlap with [lower, upper], the
	// leading decade must lie between these two exact endpoint decades.
	qLo := dLower - n + 1
	qHi := dUpper - n + 1
	if qLo < cfg.qMin {
		qLo = cfg.qMin
	}
	if qHi > cfg.qMax {
		qHi = cfg.qMax
	}
	if qLo > qHi {
		return candidate{}, false
	}

	minCoeff := pow10(n - 1)
	maxCoeff := new(big.Int).Sub(pow10(n), big.NewInt(1))

	var best candidate
	haveBest := false
	for q := qLo; q <= qHi; q++ {
		scaledLower := scaleByPowerOfTen(iv.lower, q)
		scaledUpper := scaleByPowerOfTen(iv.upper, q)
		lo := smallestIntegerAtLeast(scaledLower, iv.lowerClosed)
		hi := largestIntegerAtMost(scaledUpper, iv.upperClosed)
		if lo.Cmp(minCoeff) < 0 {
			lo.Set(minCoeff)
		}
		if hi.Cmp(maxCoeff) > 0 {
			hi.Set(maxCoeff)
		}
		if lo.Cmp(hi) > 0 {
			continue
		}

		target := scaleByPowerOfTen(v, q)
		floor := new(big.Int).Quo(target.Num(), target.Denom())
		base := new(big.Int).Set(floor)
		if base.Cmp(lo) < 0 {
			base.Set(lo)
		} else if base.Cmp(hi) > 0 {
			base.Set(hi)
		}

		seeds := make([]*big.Int, 0, 24)
		addCandidateSeeds(&seeds, base, lo, hi, 2)
		for _, c := range seeds {
			if c.Sign() <= 0 || isMultipleOfTen(c) {
				continue
			}
			cand := makeCandidate(c, q, v)
			if !haveBest || betterCandidate(cand, best) {
				best = cand
				haveBest = true
			}
		}
	}
	return best, haveBest
}

func selectShortest(absBits uint64, bf binaryFormat, cfg searchConfig) (*big.Int, int, internalInterval, error) {
	v := bf.value(absBits)
	iv := bf.absRoundingInterval(absBits)
	for n := 1; n <= cfg.maxDigits; n++ {
		if best, ok := bestCandidateForDigits(v, iv, n, cfg); ok {
			return new(big.Int).Set(best.c), best.q, iv, nil
		}
	}
	return nil, 0, internalInterval{}, errors.New("no decimal candidate within configured coefficient and exponent bounds")
}
