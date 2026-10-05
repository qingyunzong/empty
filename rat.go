package recipe

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
)

// Rat is an exact rational number num/den, kept in lowest terms with den > 0.
// All comparisons are performed by cross-multiplication of big.Int values,
// never via floating point.
type Rat struct {
	num *big.Int
	den *big.Int
}

// makeRat normalizes n/d into lowest terms with positive denominator.
// It takes ownership of n and d.
func makeRat(n, d *big.Int) Rat {
	if d.Sign() == 0 {
		panic("recipe: zero denominator")
	}
	if d.Sign() < 0 {
		n.Neg(n)
		d.Neg(d)
	}
	g := new(big.Int).GCD(nil, nil, n, d)
	n.Quo(n, g)
	d.Quo(d, g)
	return Rat{num: n, den: d}
}

// NewRat returns num/den exactly.
func NewRat(num, den int64) Rat {
	return makeRat(big.NewInt(num), big.NewInt(den))
}

// RatFromInt returns the integer x as a Rat.
func RatFromInt(x int64) Rat {
	return Rat{num: big.NewInt(x), den: big.NewInt(1)}
}

// Zero is the additive identity.
func Zero() Rat { return RatFromInt(0) }

// ParseRat parses "a/b", integers, or decimal strings exactly.
func ParseRat(s string) (Rat, error) {
	s = strings.TrimSpace(s)
	br, ok := new(big.Rat).SetString(s)
	if !ok {
		return Rat{}, fmt.Errorf("recipe: invalid rational %q", s)
	}
	return Rat{num: br.Num(), den: br.Denom()}, nil
}

func (a Rat) Add(b Rat) Rat {
	n := new(big.Int).Add(
		new(big.Int).Mul(a.num, b.den),
		new(big.Int).Mul(b.num, a.den))
	d := new(big.Int).Mul(a.den, b.den)
	return makeRat(n, d)
}

func (a Rat) Sub(b Rat) Rat {
	n := new(big.Int).Sub(
		new(big.Int).Mul(a.num, b.den),
		new(big.Int).Mul(b.num, a.den))
	d := new(big.Int).Mul(a.den, b.den)
	return makeRat(n, d)
}

func (a Rat) Mul(b Rat) Rat {
	n := new(big.Int).Mul(a.num, b.num)
	d := new(big.Int).Mul(a.den, b.den)
	return makeRat(n, d)
}

// Div panics if b is zero.
func (a Rat) Div(b Rat) Rat {
	if b.num.Sign() == 0 {
		panic("recipe: division by zero")
	}
	n := new(big.Int).Mul(a.num, b.den)
	d := new(big.Int).Mul(a.den, b.num)
	return makeRat(n, d)
}

func (a Rat) Neg() Rat {
	return Rat{num: new(big.Int).Neg(a.num), den: new(big.Int).Set(a.den)}
}

// MulInt scales a by the integer k.
func (a Rat) MulInt(k int64) Rat {
	n := new(big.Int).Mul(a.num, big.NewInt(k))
	return makeRat(n, new(big.Int).Set(a.den))
}

// Cmp compares a and b by cross-multiplication: a.num*b.den vs b.num*a.den.
// Valid because both denominators are positive. Returns -1, 0, or +1.
func (a Rat) Cmp(b Rat) int {
	lhs := new(big.Int).Mul(a.num, b.den)
	rhs := new(big.Int).Mul(b.num, a.den)
	return lhs.Cmp(rhs)
}

func (a Rat) Sign() int { return a.num.Sign() }

func (a Rat) IsZero() bool { return a.num.Sign() == 0 }

// String returns the exact ratio "p/q" (or "p" when q == 1).
func (a Rat) String() string {
	if a.den.Cmp(big.NewInt(1)) == 0 {
		return a.num.String()
	}
	return a.num.String() + "/" + a.den.String()
}

func (a Rat) MarshalJSON() ([]byte, error) {
	return json.Marshal(a.String())
}

func (a *Rat) UnmarshalJSON(data []byte) error {
	var s string
	if len(data) > 0 && data[0] == '"' {
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
	} else {
		s = string(data)
	}
	r, err := ParseRat(s)
	if err != nil {
		return err
	}
	*a = r
	return nil
}
