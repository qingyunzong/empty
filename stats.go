package statmatch

import "math/big"

// Sums accumulates exact integer power sums over aligned pairs.
type Sums struct {
	N                     int
	Sx, Sy, Sxx, Sxy, Syy *big.Int
}

// NewSums returns zeroed power sums.
func NewSums() *Sums {
	return &Sums{
		Sx:  new(big.Int),
		Sy:  new(big.Int),
		Sxx: new(big.Int),
		Sxy: new(big.Int),
		Syy: new(big.Int),
	}
}

// AddPair adds the contribution of one aligned pair (x, y).
func (s *Sums) AddPair(x, y int64) { s.addPair(x, y, 1) }

// SubPair removes the contribution of one aligned pair (x, y).
func (s *Sums) SubPair(x, y int64) { s.addPair(x, y, -1) }

func (s *Sums) addPair(x, y int64, sign int64) {
	sg := big.NewInt(sign)
	bx, by := big.NewInt(x), big.NewInt(y)
	t := new(big.Int)
	s.Sx.Add(s.Sx, t.Mul(sg, bx))
	s.Sy.Add(s.Sy, t.Mul(sg, by))
	s.Sxx.Add(s.Sxx, t.Mul(t.Mul(sg, bx), bx))
	s.Sxy.Add(s.Sxy, t.Mul(t.Mul(sg, bx), by))
	s.Syy.Add(s.Syy, t.Mul(t.Mul(sg, by), by))
	s.N += int(sign)
}

// Clone returns a deep copy.
func (s *Sums) Clone() *Sums {
	return &Sums{
		N:   s.N,
		Sx:  new(big.Int).Set(s.Sx),
		Sy:  new(big.Int).Set(s.Sy),
		Sxx: new(big.Int).Set(s.Sxx),
		Sxy: new(big.Int).Set(s.Sxy),
		Syy: new(big.Int).Set(s.Syy),
	}
}

// Equal reports whether two Sums hold identical values.
func (s *Sums) Equal(o *Sums) bool {
	return s.N == o.N &&
		s.Sx.Cmp(o.Sx) == 0 && s.Sy.Cmp(o.Sy) == 0 &&
		s.Sxx.Cmp(o.Sxx) == 0 && s.Sxy.Cmp(o.Sxy) == 0 &&
		s.Syy.Cmp(o.Syy) == 0
}

// DirectSums is the direct summation model: it recomputes all power
// sums from scratch over the given pairs, serving as the reference for
// the incremental add/remove maintenance in Aligner.
func DirectSums(pairs []Pair) *Sums {
	s := NewSums()
	for _, p := range pairs {
		s.AddPair(p.A.V, p.B.V)
	}
	return s
}

// Stats holds exact statistics over aligned pairs. Cov, VarX and VarY
// are the exact integers N·Σxy−ΣxΣy, N·Σx²−(Σx)² and N·Σy²−(Σy)²,
// i.e. N² times the population covariance and variances. The Pearson
// correlation is R = Cov/√(VarX·VarY); it is undefined (Defined ==
// false) when fewer than two pairs are aligned or either variance is
// zero.
type Stats struct {
	N       int
	Cov     *big.Int
	VarX    *big.Int
	VarY    *big.Int
	Defined bool
	R       Radical // valid only when Defined
}

// Stats derives the exact statistics from the accumulated sums.
func (s *Sums) Stats() Stats {
	n := big.NewInt(int64(s.N))
	st := Stats{N: s.N}
	st.Cov = new(big.Int).Sub(new(big.Int).Mul(n, s.Sxy), new(big.Int).Mul(s.Sx, s.Sy))
	st.VarX = new(big.Int).Sub(new(big.Int).Mul(n, s.Sxx), new(big.Int).Mul(s.Sx, s.Sx))
	st.VarY = new(big.Int).Sub(new(big.Int).Mul(n, s.Syy), new(big.Int).Mul(s.Sy, s.Sy))
	if s.N < 2 || st.VarX.Sign() <= 0 || st.VarY.Sign() <= 0 {
		return st
	}
	st.Defined = true
	st.R = correlation(st.Cov, st.VarX, st.VarY)
	return st
}
