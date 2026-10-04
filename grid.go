package rint

import (
	"errors"
	"fmt"
	"math/big"
)

// MaxVars 是网格枚举允许的最大变量数。
const MaxVars = 6

// MaxGridPoints 是网格总点数上限，防止组合爆炸。
const MaxGridPoints = 1 << 20

// Grid 描述每个变量定义域上的均匀有限网格。
// 第 i 个变量在 [Lo[i], Hi[i]] 上取 Steps[i]+1 个等距有理点。
type Grid struct {
	Lo, Hi []*big.Rat
	Steps  []int
}

// NewGrid 由变量定义域和每维分段数构造网格。
// 变量数须为 1..MaxVars，每维 Steps >= 1，总点数不超过 MaxGridPoints。
func NewGrid(dom []Interval, steps []int) (Grid, error) {
	if len(dom) == 0 || len(dom) > MaxVars {
		return Grid{}, fmt.Errorf("rint: 变量数 %d 超出范围 [1, %d]", len(dom), MaxVars)
	}
	if len(steps) != len(dom) {
		return Grid{}, errors.New("rint: steps 与变量数不一致")
	}
	total := 1
	g := Grid{Lo: make([]*big.Rat, len(dom)), Hi: make([]*big.Rat, len(dom)), Steps: make([]int, len(dom))}
	for i, d := range dom {
		if d.Undef {
			return Grid{}, fmt.Errorf("rint: 第 %d 个变量的定义域无定义", i)
		}
		if steps[i] < 1 {
			return Grid{}, fmt.Errorf("rint: 第 %d 维 steps=%d 须 >= 1", i, steps[i])
		}
		total *= steps[i] + 1
		if total > MaxGridPoints {
			return Grid{}, fmt.Errorf("rint: 网格点数 %d 超过上限 %d", total, MaxGridPoints)
		}
		g.Lo[i], g.Hi[i], g.Steps[i] = d.Lo, d.Hi, steps[i]
	}
	return g, nil
}

// Points 返回网格总点数。
func (g Grid) Points() int {
	n := 1
	for _, s := range g.Steps {
		n *= s + 1
	}
	return n
}

// point 按线性下标 idx 还原网格点坐标（混合进制）。
func (g Grid) point(idx int) []*big.Rat {
	p := make([]*big.Rat, len(g.Steps))
	for i := len(g.Steps) - 1; i >= 0; i-- {
		k := idx % (g.Steps[i] + 1)
		idx /= g.Steps[i] + 1
		// p[i] = Lo[i] + k*(Hi[i]-Lo[i])/Steps[i]
		t := new(big.Rat).Sub(g.Hi[i], g.Lo[i])
		t.Mul(t, big.NewRat(int64(k), int64(g.Steps[i])))
		p[i] = t.Add(t, g.Lo[i])
	}
	return p
}

// Certificate 是网格枚举的可核对证书：记录精确最值、取到最值的
// 网格点，以及枚举统计。Verify 可在取最值点上重新求值以核对。
type Certificate struct {
	Min, Max   *big.Rat   // 网格上的精确最小/最大值
	MinAt      []*big.Rat // 取到最小值的一个网格点
	MaxAt      []*big.Rat // 取到最大值的一个网格点
	Evaluated  int        // 有定义的求值点数
	Undefined  int        // 无定义（如除以 0）而跳过的点数
	GridPoints int        // 网格总点数
}

// Bounds 把证书的最值写成闭区间（网格值域的精确界）。
func (c Certificate) Bounds() Interval { return New(c.Min, c.Max) }

// Verify 核对证书：在 MinAt / MaxAt 上重新精确求值，
// 结果须分别等于 Min / Max。
func (c Certificate) Verify(e *Expr) bool {
	if c.Evaluated == 0 {
		return false
	}
	lo, ok := e.EvalPoint(c.MinAt)
	if !ok || lo.Cmp(c.Min) != 0 {
		return false
	}
	hi, ok := e.EvalPoint(c.MaxAt)
	if !ok || hi.Cmp(c.Max) != 0 {
		return false
	}
	return true
}

// Enumerate 在网格上逐点精确求值，返回网格值域的精确最值证书。
// 与 EvalInterval 不同，同一变量在每个点取同一有理数值，
// 因此不存在区间依赖问题导致的高估。所有求值点均无定义时返回错误。
func Enumerate(e *Expr, g Grid) (Certificate, error) {
	if e.NumVars() > len(g.Steps) {
		return Certificate{}, fmt.Errorf("rint: 表达式引用 x%d，网格只有 %d 个变量", e.NumVars()-1, len(g.Steps))
	}
	cert := Certificate{GridPoints: g.Points()}
	for idx := 0; idx < cert.GridPoints; idx++ {
		p := g.point(idx)
		v, ok := e.EvalPoint(p)
		if !ok {
			cert.Undefined++
			continue
		}
		cert.Evaluated++
		if cert.Min == nil || v.Cmp(cert.Min) < 0 {
			cert.Min = new(big.Rat).Set(v)
			cert.MinAt = p
		}
		if cert.Max == nil || v.Cmp(cert.Max) > 0 {
			cert.Max = new(big.Rat).Set(v)
			cert.MaxAt = p
		}
	}
	if cert.Evaluated == 0 {
		return cert, errors.New("rint: 网格上所有点均无定义")
	}
	return cert, nil
}

// ExactRange 是便捷入口：在定义域 dom 上按每维 steps 分段构造网格，
// 返回网格上的精确值域界与可核对证书。
func ExactRange(e *Expr, dom []Interval, steps []int) (Interval, Certificate, error) {
	g, err := NewGrid(dom, steps)
	if err != nil {
		return Interval{}, Certificate{}, err
	}
	cert, err := Enumerate(e, g)
	if err != nil {
		return Interval{}, cert, err
	}
	return cert.Bounds(), cert, nil
}
