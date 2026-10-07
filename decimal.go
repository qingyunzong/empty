// Package decimal provides arbitrary-precision decimal arithmetic using a
// coefficient-scale representation: value = coef * 10^(-scale).
//
// Addition, subtraction and multiplication are exact. Division and Round
// apply round-half-to-even (banker's rounding) at the requested precision;
// rounding happens only once, at the final operation. Division by zero
// returns an error, and negative zero is normalized to zero.
package decimal

import (
	"errors"
	"fmt"
	"math/big"
	"strings"
)

// ErrDivisionByZero is returned by Quo when the divisor is zero.
var ErrDivisionByZero = errors.New("decimal: division by zero")

// maxExp bounds the scientific-notation exponent accepted by Parse so that
// absurd inputs cannot force enormous allocations.
const maxExp = 99999

// Decimal is an arbitrary-precision decimal number.
// Its value is coef * 10^(-scale). The zero value is 0.
type Decimal struct {
	coef  *big.Int
	scale int32
}

// New returns the Decimal coef * 10^(-scale).
func New(coef int64, scale int32) Decimal {
	return Decimal{coef: big.NewInt(coef), scale: scale}.norm()
}

// Parse parses a decimal number, optionally in scientific notation.
// Accepted forms include "12", "-1.25", ".5", "1.5e3", "2.5E-2".
func Parse(s string) (Decimal, error) {
	orig := s
	if s == "" {
		return Decimal{}, fmt.Errorf("decimal: cannot parse %q", orig)
	}
	i := 0
	neg := false
	if s[i] == '+' || s[i] == '-' {
		neg = s[i] == '-'
		i++
	}
	intStart := i
	for i < len(s) && isDigit(s[i]) {
		i++
	}
	intDigits := s[intStart:i]
	fracDigits := ""
	if i < len(s) && s[i] == '.' {
		i++
		fracStart := i
		for i < len(s) && isDigit(s[i]) {
			i++
		}
		fracDigits = s[fracStart:i]
	}
	if intDigits == "" && fracDigits == "" {
		return Decimal{}, fmt.Errorf("decimal: cannot parse %q", orig)
	}
	exp := 0
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		expNeg := false
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			expNeg = s[i] == '-'
			i++
		}
		expStart := i
		for i < len(s) && isDigit(s[i]) {
			i++
		}
		if i == expStart {
			return Decimal{}, fmt.Errorf("decimal: cannot parse %q", orig)
		}
		for _, c := range s[expStart:i] {
			exp = exp*10 + int(c-'0')
			if exp > maxExp {
				return Decimal{}, fmt.Errorf("decimal: exponent out of range in %q", orig)
			}
		}
		if expNeg {
			exp = -exp
		}
	}
	if i != len(s) {
		return Decimal{}, fmt.Errorf("decimal: cannot parse %q", orig)
	}
	coef, ok := new(big.Int).SetString(intDigits+fracDigits, 10)
	if !ok {
		return Decimal{}, fmt.Errorf("decimal: cannot parse %q", orig)
	}
	if neg {
		coef.Neg(coef)
	}
	scale := int64(len(fracDigits)) - int64(exp)
	if scale > int64(^uint32(0)>>1) || scale < -int64(^uint32(0)>>1)-1 {
		return Decimal{}, fmt.Errorf("decimal: exponent out of range in %q", orig)
	}
	return Decimal{coef: coef, scale: int32(scale)}.norm(), nil
}

// MustParse is like Parse but panics on error.
func MustParse(s string) Decimal {
	d, err := Parse(s)
	if err != nil {
		panic(err)
	}
	return d
}

// Add returns a + b, exactly.
func (a Decimal) Add(b Decimal) Decimal {
	if a.coef == nil {
		a = Decimal{coef: new(big.Int)}
	}
	if b.coef == nil {
		b = Decimal{coef: new(big.Int)}
	}
	scale := a.scale
	if b.scale > scale {
		scale = b.scale
	}
	sum := new(big.Int).Add(a.aligned(scale), b.aligned(scale))
	return Decimal{coef: sum, scale: scale}.norm()
}

// Sub returns a - b, exactly.
func (a Decimal) Sub(b Decimal) Decimal {
	return a.Add(b.Neg())
}

// Neg returns -a.
func (a Decimal) Neg() Decimal {
	if a.coef == nil {
		return Decimal{coef: new(big.Int)}
	}
	return Decimal{coef: new(big.Int).Neg(a.coef), scale: a.scale}.norm()
}

// Mul returns a * b, exactly.
func (a Decimal) Mul(b Decimal) Decimal {
	ca, cb := a.coef, b.coef
	if ca == nil {
		ca = new(big.Int)
	}
	if cb == nil {
		cb = new(big.Int)
	}
	return Decimal{
		coef:  new(big.Int).Mul(ca, cb),
		scale: a.scale + b.scale,
	}.norm()
}

// Quo returns a / b rounded to prec fractional decimal digits using
// round-half-to-even. Rounding is applied once, to the final quotient.
// It returns ErrDivisionByZero if b is zero.
func (a Decimal) Quo(b Decimal, prec uint32) (Decimal, error) {
	if b.Sign() == 0 {
		return Decimal{}, ErrDivisionByZero
	}
	ca := a.coef
	if ca == nil {
		ca = new(big.Int)
	}
	// a/b = ca * 10^(b.scale - a.scale) / b.coef; scale the numerator so
	// the quotient carries prec fractional digits.
	exp := int64(b.scale) - int64(a.scale) + int64(prec)
	num := new(big.Int).Set(ca)
	den := new(big.Int).Set(b.coef)
	if exp >= 0 {
		num.Mul(num, pow10(exp))
	} else {
		den.Mul(den, pow10(-exp))
	}
	return Decimal{coef: divRoundHalfEven(num, den), scale: int32(prec)}.norm(), nil
}

// Round returns a rounded to prec fractional decimal digits using
// round-half-to-even. If a already has at most prec fractional digits,
// it is returned unchanged.
func (a Decimal) Round(prec uint32) Decimal {
	if a.coef == nil || int64(a.scale) <= int64(prec) {
		return a.norm()
	}
	drop := int64(a.scale) - int64(prec)
	coef := divRoundHalfEven(a.coef, pow10(drop))
	return Decimal{coef: coef, scale: int32(prec)}.norm()
}

// Sign returns -1, 0 or +1 depending on the sign of a.
func (a Decimal) Sign() int {
	if a.coef == nil {
		return 0
	}
	return a.coef.Sign()
}

// Cmp compares a and b, returning -1, 0 or +1.
func (a Decimal) Cmp(b Decimal) int {
	return a.Sub(b).Sign()
}

// Equal reports whether a and b represent the same number.
func (a Decimal) Equal(b Decimal) bool {
	return a.Cmp(b) == 0
}

// Coef returns the coefficient and scale such that a = coef * 10^(-scale).
func (a Decimal) Coef() (coef *big.Int, scale int32) {
	a = a.norm()
	return new(big.Int).Set(a.coef), a.scale
}

// String returns the canonical plain-notation representation of a.
func (a Decimal) String() string {
	a = a.norm()
	if a.coef.Sign() == 0 {
		return "0"
	}
	digits := a.coef.Text(10)
	neg := strings.HasPrefix(digits, "-")
	if neg {
		digits = digits[1:]
	}
	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}
	switch {
	case a.scale <= 0:
		b.WriteString(digits)
		b.WriteString(strings.Repeat("0", int(-a.scale)))
	case int(a.scale) >= len(digits):
		b.WriteString("0.")
		b.WriteString(strings.Repeat("0", int(a.scale)-len(digits)))
		b.WriteString(digits)
	default:
		point := len(digits) - int(a.scale)
		b.WriteString(digits[:point])
		b.WriteByte('.')
		b.WriteString(digits[point:])
	}
	return b.String()
}

// aligned returns the coefficient scaled to the given (larger) scale.
func (a Decimal) aligned(scale int32) *big.Int {
	c := new(big.Int).Set(a.coef)
	if scale > a.scale {
		c.Mul(c, pow10(int64(scale-a.scale)))
	}
	return c
}

// norm canonicalizes: nil coefficient becomes 0, zero gets scale 0
// (negative zero collapses to zero), and trailing zeros are stripped.
func (a Decimal) norm() Decimal {
	if a.coef == nil {
		return Decimal{coef: new(big.Int)}
	}
	if a.coef.Sign() == 0 {
		return Decimal{coef: new(big.Int)}
	}
	coef := a.coef
	scale := a.scale
	ten := big.NewInt(10)
	q, r := new(big.Int), new(big.Int)
	for scale > 0 {
		q.QuoRem(coef, ten, r)
		if r.Sign() != 0 {
			break
		}
		coef = new(big.Int).Set(q)
		scale--
	}
	return Decimal{coef: coef, scale: scale}
}

// divRoundHalfEven returns num/den rounded to the nearest integer, with
// ties rounded to the even neighbor.
func divRoundHalfEven(num, den *big.Int) *big.Int {
	sign := num.Sign() * den.Sign()
	n := new(big.Int).Abs(num)
	d := new(big.Int).Abs(den)
	q, r := new(big.Int).QuoRem(n, d, new(big.Int))
	double := new(big.Int).Lsh(r, 1)
	switch double.Cmp(d) {
	case 1:
		q.Add(q, big.NewInt(1))
	case 0:
		if q.Bit(0) == 1 {
			q.Add(q, big.NewInt(1))
		}
	}
	if sign < 0 {
		q.Neg(q)
	}
	return q
}

func pow10(exp int64) *big.Int {
	return new(big.Int).Exp(big.NewInt(10), big.NewInt(exp), nil)
}

func isDigit(c byte) bool {
	return c >= '0' && c <= '9'
}
