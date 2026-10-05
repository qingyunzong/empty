package markov

import (
	"fmt"
	"math/big"
)

// SolveRational solves the square system a x = b exactly using Gaussian
// elimination with partial pivoting over *big.Rat. The inputs are not
// modified. It returns an error if the matrix is singular.
func SolveRational(a [][]*big.Rat, b []*big.Rat) ([]*big.Rat, error) {
	n := len(a)
	if n == 0 {
		return nil, fmt.Errorf("markov: empty system")
	}
	m := make([][]*big.Rat, n)
	for i := range m {
		if len(a[i]) != n {
			return nil, fmt.Errorf("markov: row %d has %d entries, want %d", i, len(a[i]), n)
		}
		m[i] = make([]*big.Rat, n+1)
		for j := 0; j < n; j++ {
			m[i][j] = new(big.Rat).Set(a[i][j])
		}
		m[i][n] = new(big.Rat).Set(b[i])
	}
	for col := 0; col < n; col++ {
		piv := -1
		for r := col; r < n; r++ {
			if m[r][col].Sign() != 0 {
				piv = r
				break
			}
		}
		if piv == -1 {
			return nil, fmt.Errorf("markov: singular matrix at column %d", col)
		}
		m[col], m[piv] = m[piv], m[col]
		inv := new(big.Rat).Inv(m[col][col])
		for j := col; j <= n; j++ {
			m[col][j].Mul(m[col][j], inv)
		}
		for r := 0; r < n; r++ {
			if r == col || m[r][col].Sign() == 0 {
				continue
			}
			f := new(big.Rat).Set(m[r][col])
			for j := col; j <= n; j++ {
				m[r][j].Sub(m[r][j], new(big.Rat).Mul(f, m[col][j]))
			}
		}
	}
	x := make([]*big.Rat, n)
	for i := range x {
		x[i] = m[i][n]
	}
	return x, nil
}

// SolveBareiss solves the square integer system a x = b using the
// fraction-free Bareiss algorithm over *big.Int, followed by rational
// back-substitution. It is an independent cross-check for SolveRational:
// no *big.Rat arithmetic is used during elimination. The inputs are not
// modified. It returns an error if the matrix is singular.
func SolveBareiss(a [][]*big.Int, b []*big.Int) ([]*big.Rat, error) {
	n := len(a)
	if n == 0 {
		return nil, fmt.Errorf("markov: empty system")
	}
	m := make([][]*big.Int, n)
	for i := range m {
		if len(a[i]) != n {
			return nil, fmt.Errorf("markov: row %d has %d entries, want %d", i, len(a[i]), n)
		}
		m[i] = make([]*big.Int, n+1)
		for j := 0; j < n; j++ {
			m[i][j] = new(big.Int).Set(a[i][j])
		}
		m[i][n] = new(big.Int).Set(b[i])
	}
	prev := big.NewInt(1)
	for k := 0; k < n-1; k++ {
		if m[k][k].Sign() == 0 {
			piv := -1
			for r := k + 1; r < n; r++ {
				if m[r][k].Sign() != 0 {
					piv = r
					break
				}
			}
			if piv == -1 {
				return nil, fmt.Errorf("markov: singular matrix at column %d", k)
			}
			m[k], m[piv] = m[piv], m[k]
		}
		for i := k + 1; i < n; i++ {
			for j := k + 1; j <= n; j++ {
				t := new(big.Int).Mul(m[i][j], m[k][k])
				t.Sub(t, new(big.Int).Mul(m[i][k], m[k][j]))
				t.Quo(t, prev)
				m[i][j] = t
			}
			m[i][k].SetInt64(0)
		}
		prev.Set(m[k][k])
	}
	x := make([]*big.Rat, n)
	for i := n - 1; i >= 0; i-- {
		if m[i][i].Sign() == 0 {
			return nil, fmt.Errorf("markov: singular matrix at column %d", i)
		}
		s := new(big.Rat).SetInt(m[i][n])
		for j := i + 1; j < n; j++ {
			s.Sub(s, new(big.Rat).Mul(new(big.Rat).SetInt(m[i][j]), x[j]))
		}
		x[i] = s.Quo(s, new(big.Rat).SetInt(m[i][i]))
	}
	return x, nil
}

// clearDenominators converts a rational system a x = b into an integer
// system by multiplying each row by the LCM of its entry denominators.
func clearDenominators(a [][]*big.Rat, b []*big.Rat) ([][]*big.Int, []*big.Int) {
	n := len(a)
	ai := make([][]*big.Int, n)
	bi := make([]*big.Int, n)
	lcmInto := func(lcm, d *big.Int) {
		g := new(big.Int).GCD(nil, nil, lcm, d)
		lcm.Quo(lcm, g)
		lcm.Mul(lcm, d)
	}
	for i := 0; i < n; i++ {
		lcm := big.NewInt(1)
		for j := 0; j < n; j++ {
			lcmInto(lcm, a[i][j].Denom())
		}
		lcmInto(lcm, b[i].Denom())
		ai[i] = make([]*big.Int, n)
		for j := 0; j < n; j++ {
			ai[i][j] = new(big.Int).Mul(a[i][j].Num(), lcm)
			ai[i][j].Quo(ai[i][j], a[i][j].Denom())
		}
		bi[i] = new(big.Int).Mul(b[i].Num(), lcm)
		bi[i].Quo(bi[i], b[i].Denom())
	}
	return ai, bi
}
