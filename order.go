package poly

import (
	"math/big"
	"strings"
)

// VarNames are the default variable names used by String.
var VarNames = [MaxVars]string{"x", "y", "z", "u", "v"}

// CompareMonos compares two exponent vectors in lexicographic order
// (variable 0 most significant). It returns -1, 0 or +1.
func CompareMonos(a, b Mono) int {
	for i := 0; i < MaxVars; i++ {
		switch {
		case a[i] < b[i]:
			return -1
		case a[i] > b[i]:
			return 1
		}
	}
	return 0
}

// Term is a single (monomial, coefficient) pair.
type Term struct {
	Exp   Mono
	Coeff *big.Rat
}

// Terms returns the terms of p sorted in descending lexicographic monomial
// order (e.g. x^2 before x*y before y^2).
func (p *Poly) Terms() []Term {
	ts := make([]Term, 0, len(p.terms))
	for m, c := range p.terms {
		ts = append(ts, Term{m, new(big.Rat).Set(c)})
	}
	for i := 1; i < len(ts); i++ {
		for j := i; j > 0 && CompareMonos(ts[j-1].Exp, ts[j].Exp) < 0; j-- {
			ts[j-1], ts[j] = ts[j], ts[j-1]
		}
	}
	return ts
}

// String renders p with terms in descending lexicographic monomial order,
// e.g. "2*x^2 + 3/4*x*y - y^2 + 5".
func (p *Poly) String() string {
	if p.IsZero() {
		return "0"
	}
	parts := make([]string, 0, len(p.terms))
	for _, t := range p.Terms() {
		parts = append(parts, formatTerm(t))
	}
	s := strings.Join(parts, " + ")
	s = strings.ReplaceAll(s, "+ -", "- ")
	return s
}

func formatTerm(t Term) string {
	var mono strings.Builder
	for i, e := range t.Exp {
		if e == 0 {
			continue
		}
		if mono.Len() > 0 {
			mono.WriteByte('*')
		}
		mono.WriteString(VarNames[i])
		if e != 1 {
			mono.WriteByte('^')
			mono.WriteString(itoa(e))
		}
	}
	c := t.Coeff
	if mono.Len() == 0 {
		return c.RatString()
	}
	if c.Cmp(big.NewRat(1, 1)) == 0 {
		return mono.String()
	}
	if c.Cmp(big.NewRat(-1, 1)) == 0 {
		return "-" + mono.String()
	}
	return c.RatString() + "*" + mono.String()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
