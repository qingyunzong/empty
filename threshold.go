package dataeng

import (
	"math/big"
)

// exponent is an exact rational exponent n/2^d. It is never converted to a
// floating-point number or evaluated as a power.
type exponent struct {
	n int64
	d uint
}

func boundaryExponent(scale int, index int64) exponent {
	if scale >= 0 {
		return exponent{n: index, d: uint(scale)}
	}
	return exponent{n: index << uint(-scale), d: 0}
}

func thresholdExponent(t Threshold) exponent {
	return exponent{n: t.N, d: uint(t.K)}
}

// compareExponents returns -1, 0, or 1 according to the ordering of the
// exact rational exponents a and b.
func compareExponents(a, b exponent) int {
	// Compare a.n / 2^a.d with b.n / 2^b.d by cross multiplication. All
	// arithmetic is exact; no huge power value is constructed.
	var left, right big.Int
	left.SetInt64(a.n)
	left.Lsh(&left, b.d)
	right.SetInt64(b.n)
	right.Lsh(&right, a.d)
	return left.Cmp(&right)
}

func compareBoundaryToThreshold(scale int, index int64, t Threshold) int {
	if t.IsZero {
		// Every finite boundary is positive and therefore greater than
		// the value zero.
		return 1
	}
	return compareExponents(boundaryExponent(scale, index), thresholdExponent(t))
}

func compareThresholds(a, b Threshold) int {
	if a.IsZero {
		if b.IsZero {
			return 0
		}
		return -1
	}
	if b.IsZero {
		return 1
	}
	return compareExponents(thresholdExponent(a), thresholdExponent(b))
}

func maxThreshold(a, b Threshold) Threshold {
	if compareThresholds(a, b) >= 0 {
		return a
	}
	return b
}

func canonicalizeThreshold(t Threshold) Threshold {
	if t.IsZero {
		return Threshold{IsZero: true}
	}
	n, k := t.N, t.K
	for k > 0 && n%2 == 0 {
		n /= 2
		k--
	}
	return Threshold{N: n, K: k}
}

func thresholdFromBoundary(scale int, index int64) Threshold {
	if scale >= 0 {
		return canonicalizeThreshold(Threshold{N: index, K: uint8(scale)})
	}
	return canonicalizeThreshold(Threshold{N: index << uint(-scale), K: 0})
}

func validateThreshold(t Threshold) error {
	if t.K > 16 {
		return invalidf("threshold exponent denominator has k=%d, want 0..16", t.K)
	}
	if t.IsZero && (t.N != 0 || t.K != 0) {
		return invalidf("zero threshold must have N=0 and K=0")
	}
	return nil
}
