package dataeng

import (
	"math/big"
)

// referenceValue implements the formulas from the contract directly, without
// using the production binaryFormat decoder.
func referenceValue(bits uint64) *big.Rat {
	abs := bits &^ binary64SignBit
	e := (abs >> 52) & 0x7ff
	f := abs & ((1 << 52) - 1)
	var m *big.Int
	var exponent int
	if e == 0 {
		m = new(big.Int).SetUint64(f)
		exponent = -1074
	} else {
		m = new(big.Int).Lsh(big.NewInt(1), 52)
		m.Add(m, new(big.Int).SetUint64(f))
		exponent = int(e) - 1075
	}
	if exponent >= 0 {
		return new(big.Rat).SetInt(new(big.Int).Lsh(m, uint(exponent)))
	}
	return new(big.Rat).SetFrac(m, new(big.Int).Lsh(big.NewInt(1), uint(-exponent)))
}

func referenceInterval(bits uint64) internalInterval {
	abs := bits &^ binary64SignBit
	v := referenceValue(abs)
	prev := new(big.Rat)
	if abs != 1 {
		prev = referenceValue(abs - 1)
	}
	next := new(big.Rat)
	if abs == uint64(0x7fefffffffffffff) {
		next = new(big.Rat).SetInt(new(big.Int).Lsh(big.NewInt(1), 1024))
	} else {
		next = referenceValue(abs + 1)
	}
	lower := new(big.Rat).Add(v, prev)
	lower.Quo(lower, big.NewRat(2, 1))
	upper := new(big.Rat).Add(v, next)
	upper.Quo(upper, big.NewRat(2, 1))

	e := (abs >> 52) & 0x7ff
	f := abs & ((1 << 52) - 1)
	var m *big.Int
	if e == 0 {
		m = new(big.Int).SetUint64(f)
	} else {
		m = new(big.Int).Lsh(big.NewInt(1), 52)
		m.Add(m, new(big.Int).SetUint64(f))
	}
	even := m.Bit(0) == 0
	iv := internalInterval{
		lower:       lower,
		upper:       upper,
		lowerClosed: even,
		upperClosed: even && abs != uint64(0x7fefffffffffffff),
	}
	if bits&binary64SignBit != 0 {
		return internalInterval{
			lower:       new(big.Rat).Neg(iv.upper),
			upper:       new(big.Rat).Neg(iv.lower),
			lowerClosed: iv.upperClosed,
			upperClosed: iv.lowerClosed,
		}
	}
	return iv
}

func referenceDecimal(c *big.Int, q int) *big.Rat {
	if c == nil {
		return nil
	}
	p := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(absInt(q))), nil)
	if q >= 0 {
		return new(big.Rat).SetInt(new(big.Int).Mul(c, p))
	}
	return new(big.Rat).SetFrac(new(big.Int).Set(c), p)
}
