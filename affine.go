package preimage

import "math/big"

// Affine is the map x -> floor((A*x + B) / C) with C > 0.
// A may be positive (monotone non-decreasing), negative (direction
// flip: monotone non-increasing), or zero (constant map).
type Affine struct {
	A int64
	B int64
	C int64
}

// NewAffine builds an Affine, normalizing the sign so C > 0.
// It panics if c == 0.
func NewAffine(a, b, c int64) Affine {
	if c == 0 {
		panic("preimage: affine divisor must be non-zero")
	}
	if c < 0 {
		a, b, c = -a, -b, -c
	}
	return Affine{A: a, B: b, C: c}
}

// Eval returns floor((A*x + B) / C) computed exactly with big integers.
func (f Affine) Eval(x int64) int64 {
	num := big.NewInt(f.A)
	num.Mul(num, big.NewInt(x))
	num.Add(num, big.NewInt(f.B))
	// big.Int.Div is Euclidean; with C > 0 it is exactly floor division.
	num.Div(num, big.NewInt(f.C))
	return num.Int64()
}

// preimage returns the exact set of x in dom with
// yLo <= floor((A*x+B)/C) < yHi, as a single interval (the solution set of
// an affine inequality over integers is always contiguous).
func (f Affine) preimage(yLo, yHi int64, dom Interval) Interval {
	if yLo >= yHi {
		return Interval{}
	}
	// floor(v) >= yLo  <=>  v >= yLo   (yLo integer)
	// floor(v) <  yHi  <=>  v <  yHi   (yHi integer)
	// so the query is: yLo*C <= A*x + B < yHi*C.
	tLo := bigMulSub(yLo, f.C, f.B) // yLo*C - B
	tHi := bigMulSub(yHi, f.C, f.B) // yHi*C - B
	var lo, hi *big.Int
	switch {
	case f.A > 0:
		// tLo <= A*x < tHi
		lo = ceilDiv(tLo, big.NewInt(f.A))
		hi = ceilDiv(tHi, big.NewInt(f.A))
	case f.A < 0:
		// Dividing by negative A flips the inequalities (direction flip):
		// x <= floor(tLo / A) and x > tHi / A, i.e. x >= floor(tHi / A) + 1.
		a := big.NewInt(f.A)
		lo = floorDiv(tHi, a)
		lo.Add(lo, big.NewInt(1))
		hi = floorDiv(tLo, a)
		hi.Add(hi, big.NewInt(1))
	default:
		// A == 0: constant map, either the whole domain or nothing.
		if y0 := f.Eval(0); yLo <= y0 && y0 < yHi {
			return dom
		}
		return Interval{}
	}
	return Intersect(Interval{Lo: clampBig(lo), Hi: clampBig(hi)}, dom)
}

func bigMulSub(y, c, b int64) *big.Int {
	t := big.NewInt(y)
	t.Mul(t, big.NewInt(c))
	return t.Sub(t, big.NewInt(b))
}

// ceilDiv returns ceil(n/d) for d > 0.
func ceilDiv(n, d *big.Int) *big.Int {
	t := new(big.Int).Add(n, d)
	t.Sub(t, big.NewInt(1))
	return t.Div(t, d)
}

// floorDiv returns floor(n/d) for d != 0.
func floorDiv(n, d *big.Int) *big.Int {
	if d.Sign() > 0 {
		return new(big.Int).Div(n, d)
	}
	// floor(n/d) = -ceil(n/(-d))
	return new(big.Int).Neg(ceilDiv(n, new(big.Int).Neg(d)))
}

func clampBig(v *big.Int) int64 {
	if v.IsInt64() {
		return v.Int64()
	}
	if v.Sign() < 0 {
		return -9223372036854775808
	}
	return 9223372036854775807
}
