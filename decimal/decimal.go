// Package decimal parses JSON number literals exactly (no float64) and
// converts them to fixed-scale integers using round-half-to-even.
//
// A parsed number is kept as sign * mant * 10^exp with a big.Int mantissa,
// so the decimal exponent is evaluated exactly at any magnitude.
package decimal

import (
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

// MaxExp bounds the absolute value of the exponent field in a literal.
const MaxExp = 1000

var jsonNumRe = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)

// Num is an exact decimal number: value = (-1 if neg) * mant * 10^exp.
type Num struct {
	mant *big.Int // non-negative
	exp  int
	neg  bool
}

// Parse parses a JSON number literal into an exact Num.
// The exponent field must satisfy |e| <= MaxExp.
func Parse(s string) (*Num, error) {
	if !jsonNumRe.MatchString(s) {
		return nil, fmt.Errorf("invalid JSON number %q", s)
	}
	rest := s
	neg := false
	if rest[0] == '-' {
		neg = true
		rest = rest[1:]
	}
	expVal := 0
	if i := strings.IndexAny(rest, "eE"); i >= 0 {
		e, err := strconv.ParseInt(rest[i+1:], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("exponent out of range in %q (|e| must be <= %d)", s, MaxExp)
		}
		expVal = int(e)
		rest = rest[:i]
	}
	if expVal > MaxExp || expVal < -MaxExp {
		return nil, fmt.Errorf("exponent %d out of range in %q (|e| must be <= %d)", expVal, s, MaxExp)
	}
	frac := 0
	if i := strings.IndexByte(rest, '.'); i >= 0 {
		frac = len(rest) - i - 1
		rest = rest[:i] + rest[i+1:]
	}
	mant, ok := new(big.Int).SetString(rest, 10)
	if !ok {
		return nil, fmt.Errorf("invalid JSON number %q", s)
	}
	return &Num{mant: mant, exp: expVal - frac, neg: neg}, nil
}

var (
	bigTen = big.NewInt(10)
	bigOne = big.NewInt(1)
)

func pow10(n int) *big.Int {
	if n < 0 {
		panic("pow10: negative exponent")
	}
	return new(big.Int).Exp(bigTen, big.NewInt(int64(n)), nil)
}

// Quantize returns round-half-to-even of n * 10^scale as an integer.
// A zero result is never negative zero.
func Quantize(n *Num, scale int) *big.Int {
	e := n.exp + scale
	m := new(big.Int).Set(n.mant)
	if e >= 0 {
		m.Mul(m, pow10(e))
	} else {
		d := pow10(-e)
		q, r := new(big.Int).QuoRem(m, d, new(big.Int)) // m >= 0
		switch c := new(big.Int).Lsh(r, 1).Cmp(d); {
		case c > 0:
			q.Add(q, bigOne)
		case c == 0 && q.Bit(0) == 1:
			q.Add(q, bigOne)
		}
		m = q
	}
	if n.neg && m.Sign() != 0 {
		m.Neg(m)
	}
	return m
}

// Rat returns the exact rational value of n.
func (n *Num) Rat() *big.Rat {
	r := new(big.Rat).SetInt(n.mant)
	if n.exp >= 0 {
		r.Mul(r, new(big.Rat).SetInt(pow10(n.exp)))
	} else {
		r.Quo(r, new(big.Rat).SetInt(pow10(-n.exp)))
	}
	if n.neg {
		r.Neg(r)
	}
	return r
}

// RoundRatHalfEven rounds an exact rational to an integer at the given
// decimal scale (result = round-half-even(x * 10^scale)). It is the
// independent rational reference implementation used to verify Quantize.
func RoundRatHalfEven(x *big.Rat, scale int) *big.Int {
	s := new(big.Rat).Set(x)
	if scale >= 0 {
		s.Mul(s, new(big.Rat).SetInt(pow10(scale)))
	} else {
		s.Quo(s, new(big.Rat).SetInt(pow10(-scale)))
	}
	neg := s.Sign() < 0
	if neg {
		s.Neg(s)
	}
	q, r := new(big.Int).QuoRem(s.Num(), s.Denom(), new(big.Int))
	switch c := new(big.Int).Lsh(r, 1).Cmp(s.Denom()); {
	case c > 0:
		q.Add(q, bigOne)
	case c == 0 && q.Bit(0) == 1:
		q.Add(q, bigOne)
	}
	if neg {
		q.Neg(q)
	}
	return q
}

var errScale = errors.New("scale out of range (|scale| must be <= 1000)")

// CheckScale validates a scale argument.
func CheckScale(scale int) error {
	if scale < -MaxExp || scale > MaxExp {
		return errScale
	}
	return nil
}
