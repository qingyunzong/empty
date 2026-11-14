package dataeng

import (
	"math/big"
	"strings"
)

// Policy is the decimal strategy constraining conversion output and
// round-trip error. The exact policy performs all arithmetic on exact
// rationals, so a round trip A->B->A has zero error. A fixed policy
// quantizes every conversion result to a number of decimal places using
// round-half-even, bounding the round-trip error by RoundTripBound.
type Policy struct {
	exact  bool
	places int
}

// Exact returns a policy that never rounds; round-trip error is zero.
func Exact() Policy { return Policy{exact: true} }

// Fixed returns a policy that rounds conversion results to the given
// number of decimal places (round half to even).
func Fixed(places int) Policy { return Policy{places: places} }

func (p Policy) quantize(r *big.Rat) *big.Rat {
	if p.exact {
		return new(big.Rat).Set(r)
	}
	step := pow10(-p.places)
	scaled := new(big.Rat).Quo(r, step)
	return new(big.Rat).Mul(roundHalfEven(scaled), step)
}

// roundHalfEven rounds r to the nearest integer, ties to even.
func roundHalfEven(r *big.Rat) *big.Rat {
	floor := new(big.Int).Quo(r.Num(), r.Denom()) // truncated toward zero
	if r.Sign() < 0 && new(big.Int).Rem(r.Num(), r.Denom()).Sign() != 0 {
		floor.Sub(floor, big.NewInt(1))
	}
	frac := new(big.Rat).Sub(r, new(big.Rat).SetInt(floor))
	half := big.NewRat(1, 2)
	switch frac.Cmp(half) {
	case 1:
		floor.Add(floor, big.NewInt(1))
	case 0:
		if floor.Bit(0) == 1 {
			floor.Add(floor, big.NewInt(1))
		}
	}
	return new(big.Rat).SetInt(floor)
}

func (e *Expr) toBase(v *big.Rat) *big.Rat {
	if e.affine != nil {
		v = new(big.Rat).Add(v, e.affine.Offset)
	}
	return new(big.Rat).Mul(v, e.Scale)
}

func (e *Expr) fromBase(b *big.Rat) *big.Rat {
	v := new(big.Rat).Quo(b, e.Scale)
	if e.affine != nil {
		v = new(big.Rat).Sub(v, e.affine.Offset)
	}
	return v
}

// Convert converts value from one parsed expression to another. It returns
// an error when the dimension vectors differ.
func Convert(value *big.Rat, from, to *Expr) (*big.Rat, error) {
	if from.Dims != to.Dims {
		return nil, errPlain("dimension mismatch: %s and %s are not commensurable", from.text, to.text)
	}
	return to.fromBase(from.toBase(value)), nil
}

// ConvertString parses the decimal value and both unit expressions,
// converts under the given decimal policy, and formats the result.
func ConvertString(value, fromExpr, toExpr string, p Policy) (string, error) {
	v, ok := new(big.Rat).SetString(value)
	if !ok {
		return "", errPlain("invalid decimal value %q", value)
	}
	from, err := Parse(fromExpr)
	if err != nil {
		return "", err
	}
	to, err := Parse(toExpr)
	if err != nil {
		return "", err
	}
	r, err := Convert(v, from, to)
	if err != nil {
		return "", err
	}
	return formatRat(p.quantize(r), p), nil
}

// RoundTrip converts value from->to->from under the policy and returns the
// final value together with the absolute round-trip error |x” - x|.
func RoundTrip(value, fromExpr, toExpr string, p Policy) (string, *big.Rat, error) {
	v, ok := new(big.Rat).SetString(value)
	if !ok {
		return "", nil, errPlain("invalid decimal value %q", value)
	}
	from, err := Parse(fromExpr)
	if err != nil {
		return "", nil, err
	}
	to, err := Parse(toExpr)
	if err != nil {
		return "", nil, err
	}
	mid, err := Convert(v, from, to)
	if err != nil {
		return "", nil, err
	}
	back, err := Convert(p.quantize(mid), to, from)
	if err != nil {
		return "", nil, err
	}
	back = p.quantize(back)
	diff := new(big.Rat).Sub(back, v)
	return formatRat(back, p), diff.Abs(diff), nil
}

// RoundTripBound returns the guaranteed upper bound on the round-trip
// error of from->to->from under the policy. It is zero for the exact
// policy; for a fixed policy with step q = 10^-places it is
// q/2 * (1 + to.Scale/from.Scale), since each leg contributes at most half
// a quantization step and the middle-leg error is mapped back through the
// scale ratio. Affine offsets cancel and do not affect the bound.
func RoundTripBound(from, to *Expr, p Policy) (*big.Rat, error) {
	if from.Dims != to.Dims {
		return nil, errPlain("dimension mismatch: %s and %s are not commensurable", from.text, to.text)
	}
	if p.exact {
		return new(big.Rat), nil
	}
	step := pow10(-p.places)
	half := new(big.Rat).Quo(step, ratInt(2))
	ratio := new(big.Rat).Quo(to.Scale, from.Scale)
	ratio.Abs(ratio)
	return new(big.Rat).Add(half, new(big.Rat).Mul(half, ratio)), nil
}

// formatRat renders an exact rational as a decimal string. Under the exact
// policy, values with a finite decimal expansion are printed in full and
// others as "num/den". Under a fixed policy the value is printed with
// exactly the policy's decimal places.
func formatRat(r *big.Rat, p Policy) string {
	if !p.exact {
		return decimalString(r, p.places)
	}
	if s, ok := finiteDecimal(r); ok {
		return s
	}
	return r.RatString()
}

// finiteDecimal renders r as a plain decimal when its denominator only has
// factors 2 and 5.
func finiteDecimal(r *big.Rat) (string, bool) {
	den := new(big.Int).Set(r.Denom())
	twos, fives := 0, 0
	rem := new(big.Int)
	for {
		q := new(big.Int)
		q.QuoRem(den, big.NewInt(2), rem)
		if rem.Sign() != 0 {
			break
		}
		den.Set(q)
		twos++
	}
	for {
		q := new(big.Int)
		q.QuoRem(den, big.NewInt(5), rem)
		if rem.Sign() != 0 {
			break
		}
		den.Set(q)
		fives++
	}
	if den.Cmp(big.NewInt(1)) != 0 {
		return "", false
	}
	places := twos
	if fives > places {
		places = fives
	}
	num := new(big.Int).Set(r.Num())
	num.Mul(num, new(big.Int).Exp(big.NewInt(2), big.NewInt(int64(places-twos)), nil))
	num.Mul(num, new(big.Int).Exp(big.NewInt(5), big.NewInt(int64(places-fives)), nil))
	return insertPoint(num.String(), places), true
}

// decimalString renders r (already quantized to places) with exactly
// places fractional digits.
func decimalString(r *big.Rat, places int) string {
	scaled := new(big.Rat).Mul(r, pow10(places))
	if !scaled.IsInt() {
		scaled = roundHalfEven(scaled)
	}
	return insertPoint(scaled.Num().String(), places)
}

func insertPoint(digits string, places int) string {
	neg := strings.HasPrefix(digits, "-")
	if neg {
		digits = digits[1:]
	}
	for len(digits) <= places {
		digits = "0" + digits
	}
	if places > 0 {
		digits = digits[:len(digits)-places] + "." + digits[len(digits)-places:]
	}
	if neg {
		return "-" + digits
	}
	return digits
}
