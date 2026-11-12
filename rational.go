package dataeng

import (
	"fmt"
	"math/big"
)

// Rat arithmetic in this package is exact.  No helper converts to float64.

func zeroRat() *big.Rat {
	return new(big.Rat)
}

func cloneRat(r *big.Rat) *big.Rat {
	if r == nil {
		return nil
	}
	return new(big.Rat).Set(r)
}

func mulRat(a, b *big.Rat) *big.Rat {
	return new(big.Rat).Mul(a, b)
}

func addRat(a, b *big.Rat) *big.Rat {
	return new(big.Rat).Add(a, b)
}

func validateNonNegativeRat(name string, r *big.Rat) error {
	if r == nil {
		return fmt.Errorf("%s: nil rational", name)
	}
	if r.Sign() < 0 {
		return fmt.Errorf("%s: negative rational %s", name, r.RatString())
	}
	return nil
}
