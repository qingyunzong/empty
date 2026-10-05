package statcorr

import (
	"fmt"
	"math/big"
)

// Stats accumulates exact integer moments over aligned (x, y) points.
// Points can be added and removed incrementally; all sums are exact.
type Stats struct {
	n             int
	sx, sy        *big.Int
	sxx, syy, sxy *big.Int
}

// NewStats returns an empty accumulator.
func NewStats() *Stats {
	return &Stats{
		sx: new(big.Int), sy: new(big.Int),
		sxx: new(big.Int), syy: new(big.Int), sxy: new(big.Int),
	}
}

// Direct builds the direct-summation model: every moment recomputed from
// scratch over the given points. It serves as the reference for checking
// incremental add/remove updates.
func Direct(points [][2]*big.Int) *Stats {
	s := NewStats()
	for _, p := range points {
		s.Add(p[0], p[1])
	}
	return s
}

// Add incorporates one aligned point.
func (s *Stats) Add(x, y *big.Int) {
	s.n++
	s.sx.Add(s.sx, x)
	s.sy.Add(s.sy, y)
	s.sxx.Add(s.sxx, new(big.Int).Mul(x, x))
	s.syy.Add(s.syy, new(big.Int).Mul(y, y))
	s.sxy.Add(s.sxy, new(big.Int).Mul(x, y))
}

// Remove retracts a previously added aligned point.
func (s *Stats) Remove(x, y *big.Int) {
	s.n--
	s.sx.Sub(s.sx, x)
	s.sy.Sub(s.sy, y)
	s.sxx.Sub(s.sxx, new(big.Int).Mul(x, x))
	s.syy.Sub(s.syy, new(big.Int).Mul(y, y))
	s.sxy.Sub(s.sxy, new(big.Int).Mul(x, y))
}

// N returns the number of aligned points.
func (s *Stats) N() int { return s.n }

// CovNum returns the exact integer n*Sxy - Sx*Sy (n^2 times the covariance).
func (s *Stats) CovNum() *big.Int {
	n := big.NewInt(int64(s.n))
	return new(big.Int).Sub(
		new(big.Int).Mul(n, s.sxy),
		new(big.Int).Mul(s.sx, s.sy),
	)
}

// VarXNum returns the exact integer n*Sxx - Sx^2 (n^2 times the x variance).
func (s *Stats) VarXNum() *big.Int {
	n := big.NewInt(int64(s.n))
	return new(big.Int).Sub(
		new(big.Int).Mul(n, s.sxx),
		new(big.Int).Mul(s.sx, s.sx),
	)
}

// VarYNum returns the exact integer n*Syy - Sy^2 (n^2 times the y variance).
func (s *Stats) VarYNum() *big.Int {
	n := big.NewInt(int64(s.n))
	return new(big.Int).Sub(
		new(big.Int).Mul(n, s.syy),
		new(big.Int).Mul(s.sy, s.sy),
	)
}

// Correlation is the Pearson coefficient in exact radical form:
// value = Num * sqrt(Rad) / Den, with Rad squarefree.
type Correlation struct {
	Defined bool
	Reason  string   // why undefined, if not Defined
	Num     *big.Int // signed
	Den     *big.Int // positive
	Rad     *big.Int // squarefree, >= 1
}

// Correlation computes the Pearson coefficient. It is undefined when fewer
// than two aligned points exist or when either variance is zero.
func (s *Stats) Correlation() Correlation {
	if s.n < 2 {
		return Correlation{Reason: "fewer than two aligned points"}
	}
	vx, vy := s.VarXNum(), s.VarYNum()
	if vx.Sign() == 0 || vy.Sign() == 0 {
		return Correlation{Reason: "zero variance"}
	}
	a := s.CovNum()
	d := new(big.Int).Mul(vx, vy)
	k, rad := squareFactor(d) // d = k^2 * rad
	// r = a/sqrt(d) = a*sqrt(rad)/(k*rad)
	num, den := a, new(big.Int).Mul(k, rad)
	g := new(big.Int).GCD(nil, nil, new(big.Int).Abs(num), den)
	num.Quo(num, g)
	den.Quo(den, g)
	if num.Sign() == 0 {
		den.SetInt64(1)
		rad.SetInt64(1)
	}
	return Correlation{Defined: true, Num: num, Den: den, Rad: rad}
}

// String renders the coefficient, e.g. "1", "-1/2", "sqrt(3)/2",
// "5*sqrt(33)/33", or "undefined(<reason>)".
func (c Correlation) String() string {
	if !c.Defined {
		return "undefined(" + c.Reason + ")"
	}
	if c.Num.Sign() == 0 {
		return "0"
	}
	sign := ""
	if c.Num.Sign() < 0 {
		sign = "-"
	}
	abs := new(big.Int).Abs(c.Num)
	core := ""
	if abs.Cmp(big.NewInt(1)) != 0 || c.Rad.Cmp(big.NewInt(1)) == 0 {
		core = abs.String()
	}
	if c.Rad.Cmp(big.NewInt(1)) != 0 {
		if core != "" {
			core += "*"
		}
		core += "sqrt(" + c.Rad.String() + ")"
	}
	if c.Den.Cmp(big.NewInt(1)) == 0 {
		return sign + core
	}
	return sign + core + "/" + c.Den.String()
}

// Certificate renders a deterministic, verifiable summary of the exact
// moments, the integer covariance/variance numerators, and the correlation.
func (s *Stats) Certificate() string {
	return fmt.Sprintf("stats n=%d sx=%s sy=%s sxx=%s syy=%s sxy=%s covnum=%s varxnum=%s varynum=%s r=%s\n",
		s.n, s.sx, s.sy, s.sxx, s.syy, s.sxy,
		s.CovNum(), s.VarXNum(), s.VarYNum(), s.Correlation())
}

// squareFactor decomposes d > 0 as d = k^2 * s with s squarefree. Factors up
// to 1e6 are removed by trial division; a remaining cofactor is extracted by
// a perfect-square test, otherwise it is squarefree (a product of distinct
// large primes) and folded into s.
func squareFactor(d *big.Int) (k, s *big.Int) {
	k = big.NewInt(1)
	s = big.NewInt(1)
	rem := new(big.Int).Set(d)
	one := big.NewInt(1)
	limit := big.NewInt(1_000_000)
	mod := new(big.Int)
	for i := int64(2); big.NewInt(i).Cmp(limit) <= 0 && new(big.Int).Mul(big.NewInt(i), big.NewInt(i)).Cmp(rem) <= 0; i++ {
		p := big.NewInt(i)
		exp := 0
		for mod.Mod(rem, p); mod.Sign() == 0; mod.Mod(rem, p) {
			rem.Quo(rem, p)
			exp++
		}
		if exp%2 == 1 {
			s.Mul(s, p)
		}
		if exp >= 2 {
			k.Mul(k, new(big.Int).Exp(p, big.NewInt(int64(exp/2)), nil))
		}
	}
	if rem.Cmp(one) > 0 {
		sqrt := new(big.Int).Sqrt(rem)
		if new(big.Int).Mul(sqrt, sqrt).Cmp(rem) == 0 {
			k.Mul(k, sqrt)
		} else {
			s.Mul(s, rem)
		}
	}
	return k, s
}
