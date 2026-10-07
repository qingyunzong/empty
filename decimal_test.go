package decimal

import (
	"errors"
	"math/big"
	"testing"
)

func mustParse(t *testing.T, s string) Decimal {
	t.Helper()
	d, err := Parse(s)
	if err != nil {
		t.Fatalf("Parse(%q) error: %v", s, err)
	}
	return d
}

// roundRatHalfEven 是有理数参考实现：将 r 按最近偶数舍入到 prec 位小数。
func roundRatHalfEven(r *big.Rat, prec int) *big.Rat {
	scaled := new(big.Rat).Mul(r, new(big.Rat).SetInt(pow10(prec)))
	num, den := scaled.Num(), scaled.Denom()
	q, rem := new(big.Int), new(big.Int)
	q.QuoRem(num, den, rem) // 向零截断
	twice := new(big.Int).Abs(rem)
	twice.Lsh(twice, 1)
	if cmp := twice.Cmp(den); cmp > 0 || (cmp == 0 && q.Bit(0) == 1) {
		if scaled.Sign() >= 0 {
			q.Add(q, big.NewInt(1))
		} else {
			q.Sub(q, big.NewInt(1))
		}
	}
	return new(big.Rat).SetFrac(q, pow10(prec))
}

func mustRat(t *testing.T, s string) *big.Rat {
	t.Helper()
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		t.Fatalf("bad rat literal %q", s)
	}
	return r
}

func TestParse(t *testing.T) {
	cases := []struct{ in, want string }{
		{"0", "0"},
		{"42", "42"},
		{"+7", "7"},
		{"-3.14", "-3.14"},
		{".5", "0.5"},
		{"5.", "5"},
		{"007", "7"},
		{"1.23e4", "12300"},
		{"1.23e2", "123"},
		{"-5E-3", "-0.005"},
		{"2.5e-1", "0.25"},
		{"9.99e+2", "999"},
		{"1e0", "1"},
		{"12345678901234567890.0987654321", "12345678901234567890.0987654321"},
		{"1.5e-30", "0.0000000000000000000000000000015"},
	}
	for _, c := range cases {
		if got := mustParse(t, c.in).String(); got != c.want {
			t.Errorf("Parse(%q).String() = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestParseInvalid(t *testing.T) {
	for _, in := range []string{"", "abc", "1.2.3", "1e", "1e+", "e5", ".", "-", "1e1.5", "0x10", "1,5"} {
		if _, err := Parse(in); err == nil {
			t.Errorf("Parse(%q) expected error, got nil", in)
		}
	}
}

func TestNegativeZeroNormalized(t *testing.T) {
	for _, in := range []string{"-0", "-0.00", "-0e5", "-0.0e-3"} {
		d := mustParse(t, in)
		if got := d.String(); got != "0" {
			t.Errorf("Parse(%q).String() = %q, want \"0\"", in, got)
		}
		if d.Sign() != 0 {
			t.Errorf("Parse(%q).Sign() = %d, want 0", in, d.Sign())
		}
	}
	// 运算产生的零同样归一。
	zero := mustParse(t, "-2.5").Mul(mustParse(t, "0"), 10)
	if got := zero.String(); got != "0" {
		t.Errorf("(-2.5)*0 = %q, want \"0\"", got)
	}
	diff := mustParse(t, "1.5").Sub(mustParse(t, "1.5"), 10)
	if got := diff.String(); got != "0" {
		t.Errorf("1.5-1.5 = %q, want \"0\"", got)
	}
}

func TestQuoByZero(t *testing.T) {
	_, err := mustParse(t, "1").Quo(mustParse(t, "0"), 10)
	if !errors.Is(err, ErrDivByZero) {
		t.Errorf("1/0 err = %v, want ErrDivByZero", err)
	}
	_, err = mustParse(t, "1").Quo(mustParse(t, "-0.000"), 10)
	if !errors.Is(err, ErrDivByZero) {
		t.Errorf("1/(-0.000) err = %v, want ErrDivByZero", err)
	}
}

func TestRoundHalfEven(t *testing.T) {
	cases := []struct {
		in   string
		prec int
		want string
	}{
		{"2.5", 0, "2"},   // 恰半，前位偶 → 舍
		{"3.5", 0, "4"},   // 恰半，前位奇 → 入
		{"-2.5", 0, "-2"}, // 负数对称
		{"-3.5", 0, "-4"},
		{"0.125", 2, "0.12"},
		{"0.375", 2, "0.38"},
		{"0.245", 2, "0.24"},
		{"0.255", 2, "0.26"},
		{"2.51", 0, "3"}, // 过半 → 入
		{"2.49", 0, "2"}, // 不足半 → 舍
		{"9.995", 2, "10.00"},
		{"1.005", 2, "1.00"},
		{"1.015", 2, "1.02"},
		{"0.5", 0, "0"},
		{"1.234", 5, "1.234"}, // 精度已够，原样返回
	}
	for _, c := range cases {
		if got := mustParse(t, c.in).Round(c.prec).String(); got != c.want {
			t.Errorf("Round(%q, %d) = %q, want %q", c.in, c.prec, got, c.want)
		}
	}
}

// TestChainedAgainstRat 用 big.Rat 精确参考核验连算：
// 中间运算给足精度不引入舍入，仅在最终运算处按 prec 舍入。
func TestChainedAgainstRat(t *testing.T) {
	const intermediate = 40 // 中间运算精度，足以避免舍入
	cases := []struct {
		a, b, c, d string
		prec       int
	}{
		{"0.1", "0.2", "3", "7", 10},
		{"1.5", "-2.25", "0.4", "0.11", 6},
		{"123456.789", "0.001", "-99.5", "3.7", 4},
		{"-8", "2.5", "-0.125", "0.3", 0},
		{"1", "1", "1", "3", 15},
		{"2.718281828", "-1.414213562", "3.14159", "0.7071", 8},
	}
	for _, c := range cases {
		a := mustParse(t, c.a)
		b := mustParse(t, c.b)
		cc := mustParse(t, c.c)
		d := mustParse(t, c.d)

		// 十进制连算：((a+b)*c)/d，仅最后的除法按 prec 舍入。
		got, err := a.Add(b, intermediate).Mul(cc, intermediate).Quo(d, c.prec)
		if err != nil {
			t.Fatalf("chain (%s+%s)*%s/%s error: %v", c.a, c.b, c.c, c.d, err)
		}

		// 有理数参考：全程精确，最后一次性最近偶数舍入。
		ra := mustRat(t, c.a)
		rb := mustRat(t, c.b)
		rc := mustRat(t, c.c)
		rd := mustRat(t, c.d)
		exact := new(big.Rat).Mul(new(big.Rat).Add(ra, rb), rc)
		exact.Quo(exact, rd)
		want := roundRatHalfEven(exact, c.prec)

		if got.Rat().Cmp(want) != 0 {
			t.Errorf("chain ((%s+%s)*%s)/%s @prec %d = %s, want %s",
				c.a, c.b, c.c, c.d, c.prec, got.String(), want.FloatString(c.prec+2))
		}
	}
}

// TestQuoHalfValuesAgainstRat 核验除法产生恰半值时的最近偶数舍入。
func TestQuoHalfValuesAgainstRat(t *testing.T) {
	cases := []struct {
		num, den string
		prec     int
		want     string
	}{
		{"1", "2", 0, "0"},    // 0.5 恰半 → 偶 0
		{"3", "2", 0, "2"},    // 1.5 恰半 → 偶 2
		{"5", "2", 0, "2"},    // 2.5 恰半 → 偶 2
		{"1", "8", 2, "0.12"}, // 0.125 恰半 → 0.12
		{"3", "8", 2, "0.38"}, // 0.375 恰半 → 0.38
		{"-1", "8", 2, "-0.12"},
		{"1", "40", 2, "0.02"},  // 0.025 恰半 → 0.02
		{"9", "200", 2, "0.04"}, // 0.045 恰半 → 0.04
	}
	for _, c := range cases {
		got, err := mustParse(t, c.num).Quo(mustParse(t, c.den), c.prec)
		if err != nil {
			t.Fatalf("%s/%s error: %v", c.num, c.den, err)
		}
		if got.String() != c.want {
			t.Errorf("%s/%s @prec %d = %s, want %s", c.num, c.den, c.prec, got.String(), c.want)
		}
		// 与有理数参考交叉核验。
		exact := new(big.Rat).Quo(mustRat(t, c.num), mustRat(t, c.den))
		if want := roundRatHalfEven(exact, c.prec); got.Rat().Cmp(want) != 0 {
			t.Errorf("%s/%s @prec %d = %s, rat reference = %s",
				c.num, c.den, c.prec, got.String(), want.FloatString(c.prec+2))
		}
	}
}

func TestExactArithmetic(t *testing.T) {
	// 中间运算不舍入时保持精确。
	if got := mustParse(t, "0.1").Add(mustParse(t, "0.2"), 40).String(); got != "0.3" {
		t.Errorf("0.1+0.2 = %q, want \"0.3\"", got)
	}
	if got := mustParse(t, "1.1").Mul(mustParse(t, "1.1"), 40).String(); got != "1.21" {
		t.Errorf("1.1*1.1 = %q, want \"1.21\"", got)
	}
	if got := mustParse(t, "5").Sub(mustParse(t, "7.5"), 40).String(); got != "-2.5" {
		t.Errorf("5-7.5 = %q, want \"-2.5\"", got)
	}
	// 科学计数解析值参与运算。
	got, err := mustParse(t, "1.5e2").Quo(mustParse(t, "5e-1"), 2)
	if err != nil {
		t.Fatal(err)
	}
	if got.String() != "300.00" {
		t.Errorf("1.5e2 / 5e-1 = %q, want \"300.00\"", got)
	}
}
