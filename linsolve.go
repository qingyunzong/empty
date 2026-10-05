package pipes

import "math/big"

// rrefResult holds the reduced row echelon form of an augmented
// matrix [A|b] over the rationals.
type rrefResult struct {
	coeff  [][]*big.Rat // reduced coefficient rows (zero rows kept)
	rhs    []*big.Rat   // reduced right-hand side
	pivots []int        // pivot column per nonzero row
	ncols  int          // number of coefficient columns
}

// rref computes the RREF of the augmented matrix rows|rhs using exact
// rational arithmetic.
func rref(rows [][]*big.Rat, rhs []*big.Rat, ncols int) *rrefResult {
	a := make([][]*big.Rat, len(rows))
	for i, row := range rows {
		r := make([]*big.Rat, ncols)
		for j := range r {
			r[j] = new(big.Rat).Set(row[j])
		}
		a[i] = r
	}
	b := make([]*big.Rat, len(rhs))
	for i, v := range rhs {
		b[i] = new(big.Rat).Set(v)
	}

	var pivots []int
	r := 0
	for c := 0; c < ncols && r < len(a); c++ {
		sel := -1
		for i := r; i < len(a); i++ {
			if a[i][c].Sign() != 0 {
				sel = i
				break
			}
		}
		if sel < 0 {
			continue
		}
		a[r], a[sel] = a[sel], a[r]
		b[r], b[sel] = b[sel], b[r]
		inv := new(big.Rat).Inv(a[r][c])
		for j := 0; j < ncols; j++ {
			a[r][j].Mul(a[r][j], inv)
		}
		b[r].Mul(b[r], inv)
		for i := 0; i < len(a); i++ {
			if i == r || a[i][c].Sign() == 0 {
				continue
			}
			f := new(big.Rat).Set(a[i][c])
			for j := 0; j < ncols; j++ {
				a[i][j].Sub(a[i][j], new(big.Rat).Mul(f, a[r][j]))
			}
			b[i].Sub(b[i], new(big.Rat).Mul(f, b[r]))
		}
		pivots = append(pivots, c)
		r++
	}
	return &rrefResult{coeff: a, rhs: b, pivots: pivots, ncols: ncols}
}

// inconsistent reports whether some row is 0 = nonzero.
func (rr *rrefResult) inconsistent() bool {
	for i, row := range rr.coeff {
		zero := true
		for _, v := range row {
			if v.Sign() != 0 {
				zero = false
				break
			}
		}
		if zero && rr.rhs[i].Sign() != 0 {
			return true
		}
	}
	return false
}

// particular returns one solution (free variables set to zero).
func (rr *rrefResult) particular() []*big.Rat {
	x := make([]*big.Rat, rr.ncols)
	for j := range x {
		x[j] = new(big.Rat)
	}
	for i, c := range rr.pivots {
		x[c] = new(big.Rat).Set(rr.rhs[i])
	}
	return x
}

// nullspace returns a basis of {x : A x = 0} from the RREF.
func (rr *rrefResult) nullspace() [][]*big.Rat {
	isPivot := make([]bool, rr.ncols)
	for _, c := range rr.pivots {
		isPivot[c] = true
	}
	var basis [][]*big.Rat
	for f := 0; f < rr.ncols; f++ {
		if isPivot[f] {
			continue
		}
		v := make([]*big.Rat, rr.ncols)
		for j := range v {
			v[j] = new(big.Rat)
		}
		v[f].SetInt64(1)
		for i, c := range rr.pivots {
			v[c] = new(big.Rat).Neg(rr.coeff[i][f])
		}
		basis = append(basis, v)
	}
	return basis
}
