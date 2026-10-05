// Package interval provides exact arithmetic on closed intervals with
// rational endpoints, expression trees with branching, and exact extrema
// via finite grid enumeration over at most 6 variables.
package interval

import "math/big"

// Interval is a closed interval [Lo, Hi] of rational numbers.
// Undef marks an undefined value, e.g. division by an interval
// containing zero. When Undef is set, Lo and Hi are nil.
type Interval struct {
	Lo, Hi *big.Rat
	Undef  bool
}

// Rat is a shorthand for big.NewRat.
func Rat(a, b int64) *big.Rat { return big.NewRat(a, b) }

// New returns the closed interval [lo, hi]. The endpoints are swapped if
// lo > hi, and copied so later mutation of the arguments is safe.
func New(lo, hi *big.Rat) Interval {
	if lo.Cmp(hi) > 0 {
		lo, hi = hi, lo
	}
	return Interval{Lo: new(big.Rat).Set(lo), Hi: new(big.Rat).Set(hi)}
}

// Point returns the degenerate interval [r, r].
func Point(r *big.Rat) Interval { return New(r, r) }

// Undefined returns the undefined interval.
func Undefined() Interval { return Interval{Undef: true} }

// ContainsZero reports whether 0 lies in x.
func (x Interval) ContainsZero() bool {
	return !x.Undef && x.Lo.Sign() <= 0 && x.Hi.Sign() >= 0
}

func (x Interval) String() string {
	if x.Undef {
		return "undef"
	}
	return "[" + x.Lo.RatString() + ", " + x.Hi.RatString() + "]"
}

// Add returns x + y.
func (x Interval) Add(y Interval) Interval {
	if x.Undef || y.Undef {
		return Undefined()
	}
	return Interval{
		Lo: new(big.Rat).Add(x.Lo, y.Lo),
		Hi: new(big.Rat).Add(x.Hi, y.Hi),
	}
}

// Sub returns x - y.
func (x Interval) Sub(y Interval) Interval {
	if x.Undef || y.Undef {
		return Undefined()
	}
	return Interval{
		Lo: new(big.Rat).Sub(x.Lo, y.Hi),
		Hi: new(big.Rat).Sub(x.Hi, y.Lo),
	}
}

// Mul returns x * y.
func (x Interval) Mul(y Interval) Interval {
	if x.Undef || y.Undef {
		return Undefined()
	}
	prods := [4]*big.Rat{
		new(big.Rat).Mul(x.Lo, y.Lo),
		new(big.Rat).Mul(x.Lo, y.Hi),
		new(big.Rat).Mul(x.Hi, y.Lo),
		new(big.Rat).Mul(x.Hi, y.Hi),
	}
	lo, hi := prods[0], prods[0]
	for _, p := range prods[1:] {
		if p.Cmp(lo) < 0 {
			lo = p
		}
		if p.Cmp(hi) > 0 {
			hi = p
		}
	}
	return Interval{Lo: lo, Hi: hi}
}

// Div returns x / y. If y contains zero, the result is undefined.
func (x Interval) Div(y Interval) Interval {
	if x.Undef || y.Undef || y.ContainsZero() {
		return Undefined()
	}
	inv := Interval{
		Lo: new(big.Rat).Inv(y.Hi),
		Hi: new(big.Rat).Inv(y.Lo),
	}
	return x.Mul(inv)
}

// Hull returns the smallest interval containing both x and y.
// An undefined operand contributes nothing; if both are undefined the
// result is undefined.
func Hull(x, y Interval) Interval {
	if x.Undef {
		return y
	}
	if y.Undef {
		return x
	}
	lo, hi := x.Lo, x.Hi
	if y.Lo.Cmp(lo) < 0 {
		lo = y.Lo
	}
	if y.Hi.Cmp(hi) > 0 {
		hi = y.Hi
	}
	return Interval{Lo: lo, Hi: hi}
}
