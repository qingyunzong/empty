package billing

import (
	"fmt"
	"math/big"
)

var hundred = big.NewRat(100, 1)

// RoundHalfEvenCents rounds an exact rational amount to the nearest cent
// (1/100 of a currency unit), breaking ties to the even cent.
func RoundHalfEvenCents(r *big.Rat) int64 {
	scaled := new(big.Rat).Mul(r, hundred)
	num, den := scaled.Num(), scaled.Denom()
	q, rem := new(big.Int), new(big.Int)
	q.QuoRem(num, den, rem) // truncated toward zero; rem carries num's sign
	twiceRem := new(big.Int).Lsh(new(big.Int).Abs(rem), 1)
	cmp := twiceRem.Cmp(den)
	if cmp > 0 || (cmp == 0 && q.Bit(0) == 1) {
		if num.Sign() >= 0 {
			q.Add(q, big.NewInt(1))
		} else {
			q.Sub(q, big.NewInt(1))
		}
	}
	return q.Int64()
}

// FormatCents renders a cent count as a signed units.cents string.
func FormatCents(cents int64) string {
	sign := ""
	if cents < 0 {
		sign = "-"
		cents = -cents
	}
	return fmt.Sprintf("%s%d.%02d", sign, cents/100, cents%100)
}
