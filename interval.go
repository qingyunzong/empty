// Package rint 提供有理数闭区间上的精确区间运算。
//
// 数值类型为有理闭区间 [Lo, Hi]，端点使用 math/big.Rat 精确表示。
// 支持加减乘除与分支表达式；除数区间包含 0 时结果为“无定义”。
// 由于区间依赖问题（同一变量多次出现被当作独立区间），朴素区间运算
// 会高估值域；ExactRange 通过至多 6 个变量的有限网格逐点精确求值，
// 给出网格上的精确最值，并输出可供核对的枚举证书。
package rint

import (
	"fmt"
	"math/big"
)

// Interval 是有理闭区间 [Lo, Hi]。Undef 为 true 时表示无定义
// （例如除以含 0 的区间，或无定义运算的传播）。
type Interval struct {
	Lo, Hi *big.Rat
	Undef  bool
}

// New 构造闭区间 [lo, hi]；lo > hi 时 panic。
func New(lo, hi *big.Rat) Interval {
	if lo.Cmp(hi) > 0 {
		panic(fmt.Sprintf("rint: 空区间 [%v, %v]", lo, hi))
	}
	return Interval{Lo: new(big.Rat).Set(lo), Hi: new(big.Rat).Set(hi)}
}

// Const 构造退化区间 [v, v]。
func Const(v *big.Rat) Interval { return New(v, v) }

// ConstInt 构造退化区间 [v, v]，v 为整数。
func ConstInt(v int64) Interval { return Const(big.NewRat(v, 1)) }

// Undefined 返回无定义区间。
func Undefined() Interval { return Interval{Undef: true} }

// Contains 报告 x 是否落在区间内；无定义区间不含任何点。
func (i Interval) Contains(x *big.Rat) bool {
	return !i.Undef && i.Lo.Cmp(x) <= 0 && x.Cmp(i.Hi) <= 0
}

// ContainsZero 报告区间是否包含 0。
func (i Interval) ContainsZero() bool {
	return !i.Undef && i.Lo.Sign() <= 0 && i.Hi.Sign() >= 0
}

// Hull 返回能同时包含 a 与 b 的最小区间；任一无定义则结果无定义。
func Hull(a, b Interval) Interval {
	if a.Undef || b.Undef {
		return Undefined()
	}
	lo, hi := a.Lo, a.Hi
	if b.Lo.Cmp(lo) < 0 {
		lo = b.Lo
	}
	if b.Hi.Cmp(hi) > 0 {
		hi = b.Hi
	}
	return New(lo, hi)
}

// Add 区间加法：[a,b]+[c,d] = [a+c, b+d]。
func Add(a, b Interval) Interval {
	if a.Undef || b.Undef {
		return Undefined()
	}
	return New(
		new(big.Rat).Add(a.Lo, b.Lo),
		new(big.Rat).Add(a.Hi, b.Hi),
	)
}

// Sub 区间减法：[a,b]-[c,d] = [a-d, b-c]。
func Sub(a, b Interval) Interval {
	if a.Undef || b.Undef {
		return Undefined()
	}
	return New(
		new(big.Rat).Sub(a.Lo, b.Hi),
		new(big.Rat).Sub(a.Hi, b.Lo),
	)
}

// Neg 区间取负。
func Neg(a Interval) Interval {
	if a.Undef {
		return Undefined()
	}
	return New(new(big.Rat).Neg(a.Hi), new(big.Rat).Neg(a.Lo))
}

// Mul 区间乘法：端点两两相乘取最小/最大。
func Mul(a, b Interval) Interval {
	if a.Undef || b.Undef {
		return Undefined()
	}
	prods := []*big.Rat{
		new(big.Rat).Mul(a.Lo, b.Lo),
		new(big.Rat).Mul(a.Lo, b.Hi),
		new(big.Rat).Mul(a.Hi, b.Lo),
		new(big.Rat).Mul(a.Hi, b.Hi),
	}
	lo, hi := prods[0], prods[0]
	for _, p := range prods[1:] {
		if p.Cmp(lo) < 0 {
			lo = p
		}
		if p.Cmp(hi) > 0 {
			hi = p
		}
	}
	return New(lo, hi)
}

// Div 区间除法。除数区间包含 0 时结果无定义。
func Div(a, b Interval) Interval {
	if a.Undef || b.Undef {
		return Undefined()
	}
	if b.ContainsZero() {
		return Undefined()
	}
	return Mul(a, New(
		new(big.Rat).Inv(b.Hi),
		new(big.Rat).Inv(b.Lo),
	))
}

func (i Interval) String() string {
	if i.Undef {
		return "⊥(无定义)"
	}
	return fmt.Sprintf("[%v, %v]", i.Lo.RatString(), i.Hi.RatString())
}
