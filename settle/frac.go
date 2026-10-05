// Package settle 提供基于有理数的逐行金额换算、半偶舍入与合计的结算能力。
//
// 计算顺序（明确且固定）：
//  1. 每行：数量 × 单价 = 行原始金额（精确有理数）。
//  2. 每行依次应用优惠：先百分比折扣，再固定金额减免（源币种）。
//  3. 每行：乘以输入的有理汇率换算到目标币种。
//  4. 每行：对换算结果按指定小数位做半偶舍入（banker's rounding）。
//  5. 合计：把各行舍入后的金额相加。
//
// 退款：对原订单的剩余（未退）行重新执行上述完整流程，
// 退款金额 = 原订单合计 − 剩余项合计（二者均为逐行舍入后的和，差值精确）。
package settle

import (
	"fmt"
	"math/big"
)

// Frac 是规范化有理数：分母恒为正，分子分母互素，零表示为 0/1。
type Frac struct {
	num *big.Int
	den *big.Int
}

// NewFrac 由分子分母构造并规范化有理数。den 为 0 时 panic。
func NewFrac(num, den *big.Int) Frac {
	if den.Sign() == 0 {
		panic("settle: zero denominator")
	}
	n := new(big.Int).Set(num)
	d := new(big.Int).Set(den)
	if d.Sign() < 0 {
		n.Neg(n)
		d.Neg(d)
	}
	g := new(big.Int).GCD(nil, nil, new(big.Int).Abs(n), d)
	n.Quo(n, g)
	d.Quo(d, g)
	return Frac{num: n, den: d}
}

// FracFromInt 由整数构造有理数。
func FracFromInt(v int64) Frac {
	return NewFrac(big.NewInt(v), big.NewInt(1))
}

// ParseDecimal 解析十进制字符串（如 "12.34"、"-0.5"、"7"）为精确有理数。
func ParseDecimal(s string) (Frac, error) {
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		return Frac{}, fmt.Errorf("settle: cannot parse %q as decimal", s)
	}
	return NewFrac(r.Num(), r.Denom()), nil
}

// Num 返回分子的副本。
func (f Frac) Num() *big.Int { return new(big.Int).Set(f.num) }

// Den 返回分母的副本（恒为正）。
func (f Frac) Den() *big.Int { return new(big.Int).Set(f.den) }

// Add 返回 f+g。
func (f Frac) Add(g Frac) Frac {
	n := new(big.Int).Mul(f.num, g.den)
	n.Add(n, new(big.Int).Mul(g.num, f.den))
	d := new(big.Int).Mul(f.den, g.den)
	return NewFrac(n, d)
}

// Sub 返回 f-g。
func (f Frac) Sub(g Frac) Frac {
	return f.Add(g.Neg())
}

// Neg 返回 -f。
func (f Frac) Neg() Frac {
	return Frac{num: new(big.Int).Neg(f.num), den: new(big.Int).Set(f.den)}
}

// Mul 返回 f*g。
func (f Frac) Mul(g Frac) Frac {
	return NewFrac(new(big.Int).Mul(f.num, g.num), new(big.Int).Mul(f.den, g.den))
}

// Cmp 比较 f 与 g，返回 -1/0/+1。
func (f Frac) Cmp(g Frac) int {
	a := new(big.Int).Mul(f.num, g.den)
	b := new(big.Int).Mul(g.num, f.den)
	return a.Cmp(b)
}

// Sign 返回 f 的符号：-1/0/+1。
func (f Frac) Sign() int { return f.num.Sign() }

func (f Frac) String() string {
	if f.den.Cmp(big.NewInt(1)) == 0 {
		return f.num.String()
	}
	return f.num.String() + "/" + f.den.String()
}
