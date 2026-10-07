// Package poly implements symbolic arithmetic on multivariate polynomials
// with rational coefficients. Polynomials may use at most MaxVars variables;
// addition, subtraction, multiplication and non-negative integer powers are
// supported under a configurable term budget. When the budget is exhausted
// the result is truncated deterministically and tainted as uncertain, so
// equality involving such a polynomial is reported as undecidable.
package poly

import (
	"fmt"
	"math/big"
	"sort"
	"strings"
)

// MaxVars is the maximum number of distinct variables.
const MaxVars = 5

// Mono is an exponent vector, one entry per variable.
type Mono [MaxVars]uint16

// Degree returns the total degree of the monomial.
func (m Mono) Degree() int {
	d := 0
	for _, e := range m {
		d += int(e)
	}
	return d
}

// Term pairs a monomial with its non-zero coefficient.
type Term struct {
	Mono  Mono
	Coeff *big.Rat
}

// Poly is a normalized polynomial: zero coefficients are never stored.
type Poly struct {
	terms     map[Mono]*big.Rat
	uncertain bool
}

// Zero returns the zero polynomial.
func Zero() *Poly { return &Poly{terms: make(map[Mono]*big.Rat)} }

// Const returns the constant polynomial c.
func Const(c *big.Rat) *Poly {
	p := Zero()
	if c.Sign() != 0 {
		p.terms[Mono{}] = new(big.Rat).Set(c)
	}
	return p
}

// ConstInt returns the constant polynomial n.
func ConstInt(n int64) *Poly { return Const(big.NewRat(n, 1)) }

// Var returns the polynomial x_i. It panics if i is out of range.
func Var(i int) *Poly {
	if i < 0 || i >= MaxVars {
		panic(fmt.Sprintf("poly: variable index %d out of range [0,%d)", i, MaxVars))
	}
	p := Zero()
	var m Mono
	m[i] = 1
	p.terms[m] = big.NewRat(1, 1)
	return p
}

// NumTerms returns the number of non-zero terms.
func (p *Poly) NumTerms() int { return len(p.terms) }

// Uncertain reports whether the term budget was exhausted at some point while
// producing p, so p may be an incomplete (truncated) polynomial.
func (p *Poly) Uncertain() bool { return p.uncertain }

// compareMono orders monomials by graded lexicographic order: ascending total
// degree, then lexicographic on the exponent vector (x0 most significant).
func compareMono(a, b Mono) int {
	if da, db := a.Degree(), b.Degree(); da != db {
		if da < db {
			return -1
		}
		return 1
	}
	for i := 0; i < MaxVars; i++ {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// Terms returns the normalized terms in monomial order.
func (p *Poly) Terms() []Term {
	ts := make([]Term, 0, len(p.terms))
	for m, c := range p.terms {
		ts = append(ts, Term{m, new(big.Rat).Set(c)})
	}
	sort.Slice(ts, func(i, j int) bool { return compareMono(ts[i].Mono, ts[j].Mono) < 0 })
	return ts
}

// Coefficients returns the coefficients in monomial order.
func (p *Poly) Coefficients() []*big.Rat {
	ts := p.Terms()
	cs := make([]*big.Rat, len(ts))
	for i, t := range ts {
		cs[i] = t.Coeff
	}
	return cs
}

// Eval evaluates p at the given rational point; nil entries count as zero.
func (p *Poly) Eval(xs [MaxVars]*big.Rat) *big.Rat {
	sum := new(big.Rat)
	term := new(big.Rat)
	for m, c := range p.terms {
		term.Set(c)
		for i, e := range m {
			if e == 0 || xs[i] == nil {
				continue
			}
			term.Mul(term, ratPow(xs[i], int64(e)))
		}
		sum.Add(sum, term)
	}
	return sum
}

// ratPow returns x^n for a non-negative integer n.
func ratPow(x *big.Rat, n int64) *big.Rat {
	e := big.NewInt(n)
	num := new(big.Int).Exp(x.Num(), e, nil)
	den := new(big.Int).Exp(x.Denom(), e, nil)
	return new(big.Rat).SetFrac(num, den)
}

// EvalInt evaluates p at an integer point.
func (p *Poly) EvalInt(xs [MaxVars]int64) *big.Rat {
	var rs [MaxVars]*big.Rat
	for i, x := range xs {
		rs[i] = big.NewRat(x, 1)
	}
	return p.Eval(rs)
}

func (p *Poly) String() string {
	ts := p.Terms()
	if len(ts) == 0 {
		return "0"
	}
	var sb strings.Builder
	for i, t := range ts {
		c := t.Coeff
		neg := c.Sign() < 0
		if neg {
			c = new(big.Rat).Abs(c)
		}
		switch {
		case i == 0 && neg:
			sb.WriteString("-")
		case i > 0 && neg:
			sb.WriteString(" - ")
		case i > 0:
			sb.WriteString(" + ")
		}
		sb.WriteString(formatTerm(t.Mono, c))
	}
	return sb.String()
}

func formatTerm(m Mono, c *big.Rat) string {
	var sb strings.Builder
	if c.Cmp(big.NewRat(1, 1)) != 0 {
		sb.WriteString(c.RatString())
	}
	for i, e := range m {
		if e == 0 {
			continue
		}
		if sb.Len() > 0 {
			sb.WriteString("*")
		}
		fmt.Fprintf(&sb, "x%d", i)
		if e > 1 {
			fmt.Fprintf(&sb, "^%d", e)
		}
	}
	if sb.Len() == 0 {
		return c.RatString()
	}
	return sb.String()
}

// Sym is an evaluation engine carrying a term budget. Budget <= 0 means
// unlimited; otherwise any single operation result may hold at most Budget
// terms, and excess results are truncated and marked uncertain.
type Sym struct {
	Budget int
}

// NewSym returns an engine with the given term budget.
func NewSym(budget int) *Sym { return &Sym{Budget: budget} }

// normalize enforces the term budget, truncating deterministically (keeping
// the smallest monomials in monomial order) and tainting on overflow.
func (s *Sym) normalize(p *Poly) *Poly {
	if s.Budget > 0 && len(p.terms) > s.Budget {
		kept := Zero()
		kept.uncertain = true
		for _, t := range p.Terms()[:s.Budget] {
			kept.terms[t.Mono] = t.Coeff
		}
		return kept
	}
	return p
}

// Add returns a+b.
func (s *Sym) Add(a, b *Poly) *Poly {
	r := Zero()
	r.uncertain = a.uncertain || b.uncertain
	for m, c := range a.terms {
		r.terms[m] = new(big.Rat).Set(c)
	}
	for m, c := range b.terms {
		if e, ok := r.terms[m]; ok {
			e.Add(e, c)
			if e.Sign() == 0 {
				delete(r.terms, m)
			}
		} else {
			r.terms[m] = new(big.Rat).Set(c)
		}
	}
	return s.normalize(r)
}

// Neg returns -a.
func (s *Sym) Neg(a *Poly) *Poly {
	r := Zero()
	r.uncertain = a.uncertain
	for m, c := range a.terms {
		r.terms[m] = new(big.Rat).Neg(c)
	}
	return r
}

// Sub returns a-b.
func (s *Sym) Sub(a, b *Poly) *Poly { return s.Add(a, s.Neg(b)) }

// Mul returns a*b.
func (s *Sym) Mul(a, b *Poly) *Poly {
	r := Zero()
	r.uncertain = a.uncertain || b.uncertain
	for ma, ca := range a.terms {
		for mb, cb := range b.terms {
			var m Mono
			for i := range m {
				m[i] = ma[i] + mb[i]
			}
			prod := new(big.Rat).Mul(ca, cb)
			if e, ok := r.terms[m]; ok {
				e.Add(e, prod)
				if e.Sign() == 0 {
					delete(r.terms, m)
				}
			} else {
				r.terms[m] = prod
			}
		}
	}
	return s.normalize(r)
}

// Pow returns a^n for a non-negative integer n, by binary exponentiation.
func (s *Sym) Pow(a *Poly, n uint64) *Poly {
	r := ConstInt(1)
	r.uncertain = a.uncertain
	base := a
	for n > 0 {
		if n&1 == 1 {
			r = s.Mul(r, base)
		}
		n >>= 1
		if n > 0 {
			base = s.Mul(base, base)
		}
	}
	return r
}

// Equal reports whether a and b are equal after normalization. decidable is
// false when the term budget was exhausted while computing the difference,
// in which case inequality cannot be concluded.
func (s *Sym) Equal(a, b *Poly) (eq, decidable bool) {
	d := s.Sub(a, b)
	if d.uncertain {
		return false, false
	}
	return d.NumTerms() == 0, true
}
