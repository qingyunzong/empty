// Package decimal 提供基于“系数 + 尺度”表示的十进制定点运算。
//
// 数值表示为 coef * 10^(-scale)，其中 coef 为任意精度整数。
// 四则运算先精确计算，再按请求精度（小数位数）做一次最近偶数舍入，
// 即舍入只发生在最终运算处。除以零返回 ErrDivByZero，负零统一归一为零。
package decimal

import (
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
)

// ErrDivByZero 表示除数为零。
var ErrDivByZero = errors.New("decimal: division by zero")

var (
	bigOne = big.NewInt(1)
	bigTen = big.NewInt(10)
)

// Decimal 是任意精度十进制数，值等于 coef * 10^(-scale)。
type Decimal struct {
	coef  *big.Int
	scale int
}

// New 由系数与尺度构造 Decimal。
func New(coef int64, scale int) Decimal {
	return normalize(Decimal{coef: big.NewInt(coef), scale: scale})
}

// normalize 归一化：零的尺度归零（负零随之消失），并保证 coef 非 nil。
func normalize(d Decimal) Decimal {
	if d.coef == nil {
		d.coef = new(big.Int)
	}
	if d.coef.Sign() == 0 {
		d.scale = 0
	}
	return d
}

func pow10(n int) *big.Int {
	return new(big.Int).Exp(bigTen, big.NewInt(int64(n)), nil)
}

// Parse 解析十进制字符串，支持科学计数法，如 "1.23e4"、"-5E-3"、"+7"、"0.5"。
func Parse(s string) (Decimal, error) {
	orig := s
	if s == "" {
		return Decimal{}, fmt.Errorf("decimal: invalid syntax %q", orig)
	}
	neg := false
	switch s[0] {
	case '+':
		s = s[1:]
	case '-':
		neg = true
		s = s[1:]
	}

	mant := s
	exp := 0
	if i := strings.IndexAny(s, "eE"); i >= 0 {
		mant = s[:i]
		e, err := strconv.Atoi(s[i+1:])
		if err != nil {
			return Decimal{}, fmt.Errorf("decimal: invalid exponent in %q", orig)
		}
		exp = e
	}

	intPart, fracPart := mant, ""
	if i := strings.IndexByte(mant, '.'); i >= 0 {
		intPart, fracPart = mant[:i], mant[i+1:]
		if strings.IndexByte(fracPart, '.') >= 0 {
			return Decimal{}, fmt.Errorf("decimal: invalid syntax %q", orig)
		}
	}
	if intPart == "" && fracPart == "" {
		return Decimal{}, fmt.Errorf("decimal: invalid syntax %q", orig)
	}
	for _, c := range intPart + fracPart {
		if c < '0' || c > '9' {
			return Decimal{}, fmt.Errorf("decimal: invalid syntax %q", orig)
		}
	}

	coef := new(big.Int)
	digits := strings.TrimLeft(intPart+fracPart, "0")
	if digits != "" {
		coef.SetString(digits, 10)
	}
	if neg {
		coef.Neg(coef)
	}
	return normalize(Decimal{coef: coef, scale: len(fracPart) - exp}), nil
}

// Round 将 d 按最近偶数（half-even）舍入到 prec 位小数。
// 若 d 的小数位数本就不超过 prec，则原样返回。
func (d Decimal) Round(prec int) Decimal {
	if d.scale <= prec {
		return normalize(d)
	}
	p := pow10(d.scale - prec)
	q, r := new(big.Int), new(big.Int)
	q.QuoRem(d.coef, p, r) // 向零截断
	twice := new(big.Int).Abs(r)
	twice.Lsh(twice, 1)
	if cmp := twice.Cmp(p); cmp > 0 || (cmp == 0 && q.Bit(0) == 1) {
		if d.coef.Sign() >= 0 {
			q.Add(q, bigOne)
		} else {
			q.Sub(q, bigOne)
		}
	}
	return normalize(Decimal{coef: q, scale: prec})
}

// Add 返回 a+b，结果按最近偶数舍入到 prec 位小数。
func (a Decimal) Add(b Decimal, prec int) Decimal {
	scale := a.scale
	if b.scale > scale {
		scale = b.scale
	}
	sum := new(big.Int).Mul(a.coef, pow10(scale-a.scale))
	sum.Add(sum, new(big.Int).Mul(b.coef, pow10(scale-b.scale)))
	return Decimal{coef: sum, scale: scale}.Round(prec)
}

// Sub 返回 a-b，结果按最近偶数舍入到 prec 位小数。
func (a Decimal) Sub(b Decimal, prec int) Decimal {
	return a.Add(Decimal{coef: new(big.Int).Neg(b.coef), scale: b.scale}, prec)
}

// Mul 返回 a*b，结果按最近偶数舍入到 prec 位小数。
func (a Decimal) Mul(b Decimal, prec int) Decimal {
	prod := new(big.Int).Mul(a.coef, b.coef)
	return Decimal{coef: prod, scale: a.scale + b.scale}.Round(prec)
}

// Quo 返回 a/b，结果按最近偶数舍入到 prec 位小数；除数为零时返回 ErrDivByZero。
func (a Decimal) Quo(b Decimal, prec int) (Decimal, error) {
	if b.coef.Sign() == 0 {
		return Decimal{}, ErrDivByZero
	}
	// a/b = a.coef/b.coef * 10^(b.scale-a.scale)，再乘 10^prec 后取整即得目标尺度。
	num := new(big.Int).Set(a.coef)
	den := new(big.Int).Set(b.coef)
	if e := b.scale - a.scale + prec; e >= 0 {
		num.Mul(num, pow10(e))
	} else {
		den.Mul(den, pow10(-e))
	}
	q, r := new(big.Int), new(big.Int)
	q.QuoRem(num, den, r) // 向零截断
	absDen := new(big.Int).Abs(den)
	twice := new(big.Int).Abs(r)
	twice.Lsh(twice, 1)
	if cmp := twice.Cmp(absDen); cmp > 0 || (cmp == 0 && q.Bit(0) == 1) {
		if num.Sign()*den.Sign() >= 0 {
			q.Add(q, bigOne)
		} else {
			q.Sub(q, bigOne)
		}
	}
	return normalize(Decimal{coef: q, scale: prec}), nil
}

// Rat 返回 d 的精确有理数值。
func (d Decimal) Rat() *big.Rat {
	num := new(big.Int).Set(d.coef)
	den := big.NewInt(1)
	if d.scale >= 0 {
		den = pow10(d.scale)
	} else {
		num.Mul(num, pow10(-d.scale))
	}
	return new(big.Rat).SetFrac(num, den)
}

// Cmp 比较 a 与 b 的数值大小，返回 -1、0 或 1。
func (a Decimal) Cmp(b Decimal) int {
	return a.Rat().Cmp(b.Rat())
}

// Sign 返回 d 的符号：-1、0 或 1。
func (d Decimal) Sign() int {
	return d.coef.Sign()
}

// String 返回 d 的普通十进制表示（不使用科学计数法）。
func (d Decimal) String() string {
	if d.coef.Sign() == 0 {
		return "0"
	}
	digits := new(big.Int).Abs(d.coef).String()
	var out string
	switch {
	case d.scale <= 0:
		out = digits + strings.Repeat("0", -d.scale)
	case len(digits) > d.scale:
		out = digits[:len(digits)-d.scale] + "." + digits[len(digits)-d.scale:]
	default:
		out = "0." + strings.Repeat("0", d.scale-len(digits)) + digits
	}
	if d.coef.Sign() < 0 {
		return "-" + out
	}
	return out
}
