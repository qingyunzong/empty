package main

import (
	"fmt"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

// MaxExp bounds the absolute decimal exponent applied to the mantissa.
const MaxExp = 1000

// Dec is an exact decimal number: value = (-1 if neg) * mant * 10^exp.
// All arithmetic on Dec is exact; no floating point is ever involved.
type Dec struct {
	neg  bool
	mant *big.Int // non-negative
	exp  int
}

var jsonNumberRe = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)

// Parse parses a JSON number literal into an exact Dec.
// The combined decimal exponent (explicit exponent minus fractional
// digits) must satisfy |exp| <= MaxExp, otherwise an error is returned.
func Parse(s string) (Dec, error) {
	if !jsonNumberRe.MatchString(s) {
		return Dec{}, fmt.Errorf("invalid JSON number %q", s)
	}
	neg := false
	if strings.HasPrefix(s, "-") {
		neg = true
		s = s[1:]
	}
	exp := 0
	if i := strings.IndexAny(s, "eE"); i >= 0 {
		e, err := strconv.Atoi(s[i+1:])
		if err != nil {
			return Dec{}, fmt.Errorf("exponent %q out of range [-%d, %d]", s[i+1:], MaxExp, MaxExp)
		}
		s = s[:i]
		exp = e
	}
	intPart, fracPart := s, ""
	if i := strings.IndexByte(s, '.'); i >= 0 {
		intPart, fracPart = s[:i], s[i+1:]
	}
	exp -= len(fracPart)
	if exp < -MaxExp || exp > MaxExp {
		return Dec{}, fmt.Errorf("exponent %d out of range [-%d, %d]", exp, MaxExp, MaxExp)
	}
	mant, ok := new(big.Int).SetString(intPart+fracPart, 10)
	if !ok {
		return Dec{}, fmt.Errorf("invalid mantissa in %q", s)
	}
	d := Dec{neg: neg, mant: mant, exp: exp}
	if mant.Sign() == 0 {
		d.neg = false // normalize -0 to 0
	}
	return d, nil
}

// Rat returns the exact rational value of d.
func (d Dec) Rat() *big.Rat {
	r := new(big.Rat).SetInt(d.mant)
	if d.exp >= 0 {
		r.Mul(r, new(big.Rat).SetInt(pow10(d.exp)))
	} else {
		r.Quo(r, new(big.Rat).SetInt(pow10(-d.exp)))
	}
	if d.neg {
		r.Neg(r)
	}
	return r
}

// Quantize returns round-half-even of d * 10^scale as an integer.
// A result of zero is always non-negative ("negative zero" becomes 0).
func (d Dec) Quantize(scale int) *big.Int {
	e := d.exp + scale
	m := new(big.Int).Set(d.mant)
	if e >= 0 {
		m.Mul(m, pow10(e))
		if d.neg {
			m.Neg(m)
		}
		return m
	}
	q := roundHalfEvenQuotient(m, pow10(-e))
	if d.neg {
		q.Neg(q)
	}
	return q
}

// roundHalfEvenQuotient divides non-negative m by positive div,
// rounding the quotient to the nearest integer, ties to even.
func roundHalfEvenQuotient(m, div *big.Int) *big.Int {
	q, r := new(big.Int).QuoRem(m, div, new(big.Int))
	twice := new(big.Int).Lsh(r, 1)
	switch c := twice.Cmp(div); {
	case c > 0:
		q.Add(q, big.NewInt(1))
	case c == 0 && q.Bit(0) == 1:
		q.Add(q, big.NewInt(1))
	}
	return q
}
