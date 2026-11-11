package q255

import "math/big"

// cmpRational compares aNum/aDen with bNum/bDen exactly and returns -1, 0 or 1.
//
// Denominators are always positive track time bases, so cross multiplication
// preserves the ordering. big.Int is used because track ticks can be large
// (e.g. 90 kHz video over long content) and the products of two int64 values
// may overflow machine integers. No conversion to milliseconds, float or any
// shared scale is performed; the comparison is exact for every time base.
func cmpRational(aNum, aDen, bNum, bDen int64) int {
	left := new(big.Int).Mul(big.NewInt(aNum), big.NewInt(bDen))
	right := new(big.Int).Mul(big.NewInt(bNum), big.NewInt(aDen))
	return left.Cmp(right)
}
