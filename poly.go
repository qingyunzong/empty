// Package poly implements sparse multivariate polynomials with rational
// coefficients over at most MaxVars variables. Arithmetic operations take a
// term budget: if any intermediate or final result would exceed the budget,
// the operation fails with ErrBudgetExhausted. Equality is decided on
// normalized forms; when the budget is exhausted no conclusion about
// inequality can be drawn.
package poly

import (
	"errors"
	"math/big"
)

// MaxVars is the maximum number of variables supported.
const MaxVars = 5

// ErrBudgetExhausted is returned when an operation would produce (or
// intermediate computation would require) more terms than the given budget.
var ErrBudgetExhausted = errors.New("poly: term budget exhausted")

// Mono is a monomial exponent vector, one entry per variable.
type Mono [MaxVars]int

// Poly is a sparse polynomial: monomial exponent vector -> coefficient.
// The zero polynomial has no terms. Coefficients are never zero in a
// normalized Poly.
type Poly struct {
	terms map[Mono]*big.Rat
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

// ConstInt returns the constant polynomial c.
func ConstInt(c int64) *Poly { return Const(big.NewRat(c, 1)) }

// Var returns the polynomial consisting of the single variable i (0-based,
// must be < MaxVars).
func Var(i int) *Poly {
	if i < 0 || i >= MaxVars {
		panic("poly: variable index out of range")
	}
	p := Zero()
	var m Mono
	m[i] = 1
	p.terms[m] = big.NewRat(1, 1)
	return p
}

// Monomial returns c * x_0^e0 * ... * x_4^e4.
func Monomial(c *big.Rat, exp Mono) *Poly {
	p := Zero()
	if c.Sign() != 0 {
		p.terms[exp] = new(big.Rat).Set(c)
	}
	return p
}

// NumTerms reports the number of (nonzero) terms.
func (p *Poly) NumTerms() int { return len(p.terms) }

// IsZero reports whether p is the zero polynomial.
func (p *Poly) IsZero() bool { return len(p.terms) == 0 }

// Clone returns a deep copy of p.
func (p *Poly) Clone() *Poly {
	q := Zero()
	for m, c := range p.terms {
		q.terms[m] = new(big.Rat).Set(c)
	}
	return q
}

// Coeff returns the coefficient of the monomial with exponent vector exp
// (zero if absent).
func (p *Poly) Coeff(exp Mono) *big.Rat {
	if c, ok := p.terms[exp]; ok {
		return new(big.Rat).Set(c)
	}
	return new(big.Rat)
}

// set inserts or updates a term, dropping zero coefficients, and enforces
// the term budget.
func (p *Poly) set(m Mono, c *big.Rat, budget int) error {
	if c.Sign() == 0 {
		delete(p.terms, m)
		return nil
	}
	if _, ok := p.terms[m]; !ok && len(p.terms) >= budget {
		return ErrBudgetExhausted
	}
	p.terms[m] = c
	return nil
}

// Add returns a+b, or ErrBudgetExhausted if the result needs more than
// budget terms.
func Add(a, b *Poly, budget int) (*Poly, error) {
	r := a.Clone()
	for m, c := range b.terms {
		sum := new(big.Rat)
		if old, ok := r.terms[m]; ok {
			sum.Add(old, c)
		} else {
			sum.Set(c)
		}
		if err := r.set(m, sum, budget); err != nil {
			return nil, err
		}
	}
	return r, nil
}

// Neg returns -p.
func Neg(p *Poly) *Poly {
	r := Zero()
	for m, c := range p.terms {
		r.terms[m] = new(big.Rat).Neg(c)
	}
	return r
}

// Sub returns a-b, or ErrBudgetExhausted if the result needs more than
// budget terms.
func Sub(a, b *Poly, budget int) (*Poly, error) {
	r := a.Clone()
	for m, c := range b.terms {
		diff := new(big.Rat)
		if old, ok := r.terms[m]; ok {
			diff.Sub(old, c)
		} else {
			diff.Neg(c)
		}
		if err := r.set(m, diff, budget); err != nil {
			return nil, err
		}
	}
	return r, nil
}

// Mul returns a*b, or ErrBudgetExhausted if the result needs more than
// budget terms.
func Mul(a, b *Poly, budget int) (*Poly, error) {
	r := Zero()
	for ma, ca := range a.terms {
		for mb, cb := range b.terms {
			var m Mono
			for i := range m {
				m[i] = ma[i] + mb[i]
			}
			prod := new(big.Rat).Mul(ca, cb)
			if old, ok := r.terms[m]; ok {
				prod.Add(prod, old)
			}
			if err := r.set(m, prod, budget); err != nil {
				return nil, err
			}
		}
	}
	return r, nil
}

// Pow returns p^n for a non-negative integer n, using exponentiation by
// squaring. It fails with ErrBudgetExhausted if any intermediate or final
// result needs more than budget terms.
func Pow(p *Poly, n uint, budget int) (*Poly, error) {
	result := ConstInt(1)
	base := p.Clone()
	for n > 0 {
		if n&1 == 1 {
			var err error
			result, err = Mul(result, base, budget)
			if err != nil {
				return nil, err
			}
		}
		n >>= 1
		if n > 0 {
			var err error
			base, err = Mul(base, base, budget)
			if err != nil {
				return nil, err
			}
		}
	}
	return result, nil
}

// Equal reports whether a and b are equal after normalization (a-b == 0).
// If the term budget is exhausted while forming the difference, known is
// false: equality is undecided and no conclusion about inequality may be
// drawn.
func Equal(a, b *Poly, budget int) (equal, known bool) {
	d, err := Sub(a, b, budget)
	if err != nil {
		return false, false
	}
	return d.IsZero(), true
}
