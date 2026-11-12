package dataeng

import "math/big"

// ratCopy returns an independent copy of r; nil is treated as zero.
func ratCopy(r *big.Rat) *big.Rat {
	if r == nil {
		return new(big.Rat)
	}
	return new(big.Rat).Set(r)
}

// ratSum returns the sum a+b without mutating either operand.
func ratSum(a, b *big.Rat) *big.Rat {
	return new(big.Rat).Add(a, b)
}

// ratSub returns a-b without mutating either operand.
func ratSub(a, b *big.Rat) *big.Rat {
	return new(big.Rat).Sub(a, b)
}

// ratMul returns a*b without mutating either operand.
func ratMul(a, b *big.Rat) *big.Rat {
	return new(big.Rat).Mul(a, b)
}

// ratIsPositive reports r > 0 exactly.
func ratIsPositive(r *big.Rat) bool {
	return r != nil && r.Sign() > 0
}

// ratIsNegative reports r < 0 exactly.
func ratIsNegative(r *big.Rat) bool {
	return r != nil && r.Sign() < 0
}
