package billing

import (
	"math/big"
	"testing"
)

// 分位最近偶数舍入（round-half-to-even / 银行家舍入）。
func TestToCentsHalfEven(t *testing.T) {
	cases := []struct {
		amount string // 元（精确分数）
		want   int64  // 分
	}{
		{"1/8", 12},    // 0.125 → 12.5 分, 平局取偶 → 12
		{"27/200", 14}, // 0.135 → 13.5 分, 平局取偶 → 14
		{"1/200", 0},   // 0.005 → 0.5 分 → 0
		{"3/200", 2},   // 0.015 → 1.5 分 → 2
		{"5/2", 250},   // 2.50 → 250
		{"4/3", 133},   // 1.333... → 133
		{"-1/8", -12},  // 负数同样向偶
		{"-27/200", -14},
		{"0", 0},
	}
	for _, c := range cases {
		r, ok := new(big.Rat).SetString(c.amount)
		if !ok {
			t.Fatalf("非法分数 %q", c.amount)
		}
		if got := ToCentsHalfEven(r); got != c.want {
			t.Errorf("ToCentsHalfEven(%s) = %d, 期望 %d", c.amount, got, c.want)
		}
	}
}

func TestRoundHalfEvenInt(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"5/2", "2"},   // 2.5 → 2
		{"7/2", "4"},   // 3.5 → 4
		{"9/2", "4"},   // 4.5 → 4
		{"-5/2", "-2"}, // -2.5 → -2
		{"-7/2", "-4"}, // -3.5 → -4
		{"13/5", "3"},  // 2.6 → 3
		{"12/5", "2"},  // 2.4 → 2
	}
	for _, c := range cases {
		r, _ := new(big.Rat).SetString(c.in)
		if got := RoundHalfEvenInt(r).String(); got != c.want {
			t.Errorf("RoundHalfEvenInt(%s) = %s, 期望 %s", c.in, got, c.want)
		}
	}
}
