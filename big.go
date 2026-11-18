package formal

import "math/big"

func mulDivBig(a, b, c int64) (int64, int64) {
	product := new(big.Int).Mul(big.NewInt(a), big.NewInt(b))
	quotient, remainder := new(big.Int), new(big.Int)
	quotient.QuoRem(product, big.NewInt(c), remainder)
	if !quotient.IsInt64() {
		return 0, 0
	}
	return quotient.Int64(), remainder.Int64()
}
