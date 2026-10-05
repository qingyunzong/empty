package markov

import (
	"fmt"
	"math/big"
)

// SolveGauss solves A x = b exactly by Gauss-Jordan elimination with
// partial pivoting over *big.Rat. Returns an error on singular matrices.
func SolveGauss(a [][]*big.Rat, b []*big.Rat) ([]*big.Rat, error) {
	n := len(a)
	if n == 0 || len(b) != n {
		return nil, fmt.Errorf("SolveGauss: bad dimensions")
	}
	m := make([][]*big.Rat, n)
	for i := range a {
		if len(a[i]) != n {
			return nil, fmt.Errorf("SolveGauss: row %d has %d columns, want %d",
				i, len(a[i]), n)
		}
		row := make([]*big.Rat, n+1)
		for j, v := range a[i] {
			row[j] = new(big.Rat).Set(v)
		}
		row[n] = new(big.Rat).Set(b[i])
		m[i] = row
	}
	for col := 0; col < n; col++ {
		piv := -1
		for r := col; r < n; r++ {
			if m[r][col].Sign() != 0 {
				piv = r
				break
			}
		}
		if piv < 0 {
			return nil, fmt.Errorf("SolveGauss: singular matrix (column %d)", col)
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
	for i := 0; i < n; i++ {
		x[i] = m[i][n]
	}
	return x, nil
}

// SolveBareiss solves A x = b by the fraction-free Bareiss algorithm over
// big.Int (rows are first scaled to integers by their denominators' LCM),
// followed by rational back substitution. It shares no code with
// SolveGauss and is used as an independent cross-check.
func SolveBareiss(a [][]*big.Rat, b []*big.Rat) ([]*big.Rat, error) {
	n := len(a)
	if n == 0 || len(b) != n {
		return nil, fmt.Errorf("SolveBareiss: bad dimensions")
	}
	m := make([][]*big.Int, n)
	for i := range a {
		if len(a[i]) != n {
			return nil, fmt.Errorf("SolveBareiss: row %d has %d columns, want %d",
				i, len(a[i]), n)
		}
		lcm := big.NewInt(1)
		for j := 0; j < n; j++ {
			lcm = lcmInt(lcm, a[i][j].Denom())
		}
		lcm = lcmInt(lcm, b[i].Denom())
		row := make([]*big.Int, n+1)
		for j := 0; j < n; j++ {
			row[j] = scaleRat(a[i][j], lcm)
		}
		row[n] = scaleRat(b[i], lcm)
		m[i] = row
	}
	prev := big.NewInt(1)
	for k := 0; k < n-1; k++ {
		p := -1
		for r := k; r < n; r++ {
			if m[r][k].Sign() != 0 {
				p = r
				break
			}
		}
		if p < 0 {
			return nil, fmt.Errorf("SolveBareiss: singular matrix (column %d)", k)
		}
		if p != k {
			m[k], m[p] = m[p], m[k]
		}
		for i := k + 1; i < n; i++ {
			for j := k + 1; j <= n; j++ {
				t := new(big.Int).Mul(m[i][j], m[k][k])
				t.Sub(t, new(big.Int).Mul(m[i][k], m[k][j]))
				t.Quo(t, prev) // exact division by the Bareiss invariant
				m[i][j] = t
			}
		}
		for i := k + 1; i < n; i++ {
			m[i][k] = new(big.Int)
		}
		prev = m[k][k]
	}
	x := make([]*big.Rat, n)
	for i := n - 1; i >= 0; i-- {
		if m[i][i].Sign() == 0 {
			return nil, fmt.Errorf("SolveBareiss: singular matrix")
		}
		num := new(big.Rat).SetInt(m[i][n])
		for j := i + 1; j < n; j++ {
			num.Sub(num, new(big.Rat).Mul(new(big.Rat).SetInt(m[i][j]), x[j]))
		}
		x[i] = num.Quo(num, new(big.Rat).SetInt(m[i][i]))
	}
	return x, nil
}

func lcmInt(a, b *big.Int) *big.Int {
	g := new(big.Int).GCD(nil, nil, a, b)
	q := new(big.Int).Quo(a, g)
	return q.Mul(q, b)
}

// scaleRat returns v * lcm as an integer; lcm must be a multiple of v's
// denominator.
func scaleRat(v *big.Rat, lcm *big.Int) *big.Int {
	q := new(big.Int).Quo(lcm, v.Denom())
	return q.Mul(q, v.Num())
}
