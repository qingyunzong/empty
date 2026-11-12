package dataeng

import (
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// Term is one canonical monomial. Exponents is aligned with
// Polynomial.Variables, so Exponents contains zeros for variables that do not
// occur in the monomial. Coefficient is always non-negative.
type Term struct {
	Exponents   []int
	Coefficient big.Int
}

// Polynomial is a canonical sparse polynomial over non-negative integer
// coefficients.
//
// Variables is sorted by ID. Terms is sorted lexicographically by Exponents,
// and every pair of terms has a distinct Exponents vector. Zero terms are
// absent, so the zero polynomial has no variables and no terms.
type Polynomial struct {
	Variables []string
	Terms     []Term
}

// TermCount returns the number of non-zero monomials.
func (p *Polynomial) TermCount() int {
	if p == nil {
		return 0
	}
	return len(p.Terms)
}

// IsZero reports whether p is the zero polynomial.
func (p *Polynomial) IsZero() bool {
	return p == nil || len(p.Terms) == 0
}

// Clone returns an independent copy of p.
func (p *Polynomial) Clone() *Polynomial {
	if p == nil {
		return nil
	}
	clone := &Polynomial{
		Variables: append([]string(nil), p.Variables...),
		Terms:     make([]Term, len(p.Terms)),
	}
	for i, term := range p.Terms {
		clone.Terms[i].Exponents = append([]int(nil), term.Exponents...)
		clone.Terms[i].Coefficient.Set(&term.Coefficient)
	}
	return clone
}

// Equal reports whether p and q have the same canonical representation.
func (p *Polynomial) Equal(q *Polynomial) bool {
	if p == nil || q == nil {
		return p.IsZero() && q.IsZero()
	}
	if len(p.Terms) != len(q.Terms) || len(p.Variables) != len(q.Variables) {
		return false
	}
	for i, id := range p.Variables {
		if id != q.Variables[i] {
			return false
		}
	}
	for i, term := range p.Terms {
		other := q.Terms[i]
		if term.Coefficient.Cmp(&other.Coefficient) != 0 ||
			len(term.Exponents) != len(other.Exponents) {
			return false
		}
		for j, exponent := range term.Exponents {
			if exponent != other.Exponents[j] {
				return false
			}
		}
	}
	return true
}

// CompareExponents compares two exponent lists lexicographically in ascending
// order. Lists of equal prefix length compare by their common prefix.
func CompareExponents(a, b []int) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] < b[i] {
			return -1
		}
		if a[i] > b[i] {
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	default:
		return 0
	}
}

// Evaluate evaluates p at the supplied integer assignments. Every variable
// occurring in p must be assigned. The returned value is a new big.Int.
func (p *Polynomial) Evaluate(assign map[string]*big.Int) (*big.Int, error) {
	if p == nil || len(p.Terms) == 0 {
		return new(big.Int), nil
	}
	total := new(big.Int)
	termValue := new(big.Int)
	power := new(big.Int)
	for _, term := range p.Terms {
		termValue.SetInt64(1)
		for i, variable := range p.Variables {
			exponent := term.Exponents[i]
			if exponent == 0 {
				continue
			}
			value, ok := assign[variable]
			if !ok || value == nil {
				return nil, &MissingVariableError{ID: variable}
			}
			power.Exp(value, big.NewInt(int64(exponent)), nil)
			termValue.Mul(termValue, power)
		}
		termValue.Mul(termValue, &term.Coefficient)
		total.Add(total, termValue)
	}
	return total, nil
}

// EvaluateInt evaluates p at small integer assignments.
func (p *Polynomial) EvaluateInt(assign map[string]int64) (*big.Int, error) {
	if p == nil || len(p.Terms) == 0 {
		return new(big.Int), nil
	}
	values := make(map[string]*big.Int, len(assign))
	for id, value := range assign {
		values[id] = big.NewInt(value)
	}
	return p.Evaluate(values)
}

// String renders p in a compact human-readable form.
func (p *Polynomial) String() string {
	if p == nil || len(p.Terms) == 0 {
		return "0"
	}
	var b strings.Builder
	for i, term := range p.Terms {
		if i > 0 {
			b.WriteString(" + ")
		}
		var monomial strings.Builder
		for j, variable := range p.Variables {
			exponent := term.Exponents[j]
			if exponent == 0 {
				continue
			}
			if monomial.Len() > 0 {
				monomial.WriteByte('*')
			}
			monomial.WriteString(formatVariableID(variable))
			if exponent != 1 {
				fmt.Fprintf(&monomial, "^%d", exponent)
			}
		}
		switch {
		case term.Coefficient.Cmp(big.NewInt(1)) != 0:
			b.WriteString(term.Coefficient.String())
			if monomial.Len() > 0 {
				b.WriteByte('*')
				b.WriteString(monomial.String())
			}
		case monomial.Len() > 0:
			b.WriteString(monomial.String())
		default:
			b.WriteByte('1')
		}
	}
	return b.String()
}

func formatVariableID(id string) string {
	for _, r := range id {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '$' {
			return strconv.Quote(id)
		}
	}
	if id == "" {
		return `""`
	}
	return id
}

func sortTerms(terms []Term) {
	sort.Slice(terms, func(i, j int) bool {
		return CompareExponents(terms[i].Exponents, terms[j].Exponents) < 0
	})
}
