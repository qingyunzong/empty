package billing

import "math/big"

// RoundHalfEvenInt 把有理数舍入到最近的整数，平局（恰为 .5）时取偶数。
// 对负数同样适用（向绝对值更大的偶数方向）。
func RoundHalfEvenInt(r *big.Rat) *big.Int {
	num, den := r.Num(), r.Denom()
	q, m := new(big.Int), new(big.Int)
	q.DivMod(num, den, m) // 欧几里得除法：0 <= m < den
	twice := new(big.Int).Lsh(m, 1)
	switch twice.Cmp(den) {
	case -1:
		return q
	case 1:
		return q.Add(q, big.NewInt(1))
	default: // 平局：取偶数
		if q.Bit(0) == 1 {
			q.Add(q, big.NewInt(1))
		}
		return q
	}
}

// ToCentsHalfEven 把精确金额（元）按最近偶数舍入到分，返回整数分。
func ToCentsHalfEven(amount *big.Rat) int64 {
	scaled := new(big.Rat).Mul(amount, big.NewRat(100, 1))
	return RoundHalfEvenInt(scaled).Int64()
}
