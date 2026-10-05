package settle

import (
	"fmt"
	"math/big"
)

// HalfRelation 描述被舍弃部分与“半个最小单位”的关系。
type HalfRelation int

const (
	LessThanHalf    HalfRelation = iota - 1 // 不足一半，舍去
	ExactlyHalf                             // 恰好一半，向偶数舍入
	GreaterThanHalf                         // 超过一半，进位
)

func (h HalfRelation) String() string {
	switch h {
	case LessThanHalf:
		return "less-than-half"
	case ExactlyHalf:
		return "exactly-half"
	case GreaterThanHalf:
		return "greater-than-half"
	}
	return "unknown"
}

// RoundEvidence 记录一次半偶舍入的全部证据。
type RoundEvidence struct {
	// Exact 是舍入前的精确值（规范化分子/分母）。
	Exact Frac
	// Scale 是保留的小数位数。
	Scale int
	// ScaledNum/ScaledDen 是 Exact × 10^Scale 的规范化分子/分母。
	ScaledNum *big.Int
	ScaledDen *big.Int
	// Quotient 是向零截断的商（舍入后最小单位的整数部分，未做半偶调整）。
	Quotient *big.Int
	// Remainder 是被舍弃的余数（与商同号，|Remainder| < ScaledDen）。
	Remainder *big.Int
	// Relation 是 |Remainder| 与 ScaledDen/2 的比较结果。
	Relation HalfRelation
	// Rounded 是半偶舍入后的最小单位整数值（int64 的 Scale 位小数）。
	Rounded *big.Int
}

// String 以人类可读形式输出舍入证据。
func (e RoundEvidence) String() string {
	return fmt.Sprintf("exact=%s scaled=%s/%s q=%s r=%s half=%s rounded=%s",
		e.Exact, e.ScaledNum, e.ScaledDen, e.Quotient, e.Remainder, e.Relation, e.Rounded)
}

// RoundHalfEven 将 f 半偶舍入到 scale 位小数，返回舍入后的最小单位整数与证据。
// 例如 f=5/2、scale=0：2.5 → 2（偶数）；f=3/2、scale=0：1.5 → 2。
func RoundHalfEven(f Frac, scale int) (rounded *big.Int, ev RoundEvidence) {
	if scale < 0 {
		panic("settle: negative scale")
	}
	pow := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)
	sn := new(big.Int).Mul(f.num, pow)
	sd := new(big.Int).Set(f.den)
	g := new(big.Int).GCD(nil, nil, new(big.Int).Abs(sn), sd)
	sn.Quo(sn, g)
	sd.Quo(sd, g)

	q, r := new(big.Int).QuoRem(sn, sd, new(big.Int))

	absR := new(big.Int).Abs(r)
	twoAbsR := new(big.Int).Lsh(absR, 1)
	cmp := twoAbsR.Cmp(sd)
	var rel HalfRelation
	switch {
	case cmp < 0:
		rel = LessThanHalf
	case cmp == 0:
		rel = ExactlyHalf
	default:
		rel = GreaterThanHalf
	}

	rounded = new(big.Int).Set(q)
	switch rel {
	case GreaterThanHalf:
		rounded.Add(rounded, signOf(sn))
	case ExactlyHalf:
		// 向偶数：商为奇数时进位。
		if new(big.Int).Abs(q).Bit(0) == 1 {
			rounded.Add(rounded, signOf(sn))
		}
	}

	ev = RoundEvidence{
		Exact:     f,
		Scale:     scale,
		ScaledNum: sn,
		ScaledDen: sd,
		Quotient:  q,
		Remainder: r,
		Relation:  rel,
		Rounded:   new(big.Int).Set(rounded),
	}
	return rounded, ev
}

func signOf(v *big.Int) *big.Int {
	if v.Sign() < 0 {
		return big.NewInt(-1)
	}
	return big.NewInt(1)
}
