package settle

import "testing"

func TestParseFrac(t *testing.T) {
	cases := map[string]string{
		"19.99":   "1999/100",
		"-3.5":    "-7/2",
		"0.005":   "1/200",
		"7/3":     "7/3",
		"-4/6":    "-2/3",
		"3/-9":    "-1/3",
		"42":      "42",
		"+1.25":   "5/4",
		".5":      "1/2",
		"0":       "0",
		"-0.0001": "-1/10000",
	}
	for in, want := range cases {
		got := MustParse(in)
		if got.String() != want {
			t.Errorf("ParseFrac(%q) = %s, want %s", in, got.String(), want)
		}
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Error("expected panic on zero denominator")
			}
		}()
		MustParse("1/0")
	}()
}

func TestRoundHalfEven(t *testing.T) {
	cases := []struct {
		in    string
		scale int
		want  string
		rule  RoundRule
	}{
		{"0.125", 2, "0.12", RuleTieToEven}, // 2 is even
		{"0.375", 2, "0.38", RuleTieToEven}, // 8 is even
		{"0.5", 0, "0", RuleTieToEven},      // 0 is even
		{"1.5", 0, "2", RuleTieToEven},      // 2 is even
		{"2.5", 0, "2", RuleTieToEven},      // 2 is even
		{"-2.5", 0, "-2", RuleTieToEven},    // symmetric
		{"-0.125", 2, "-0.12", RuleTieToEven},
		{"0.124", 2, "0.12", RuleDown},
		{"0.126", 2, "0.13", RuleUp},
		{"-0.126", 2, "-0.13", RuleUp},
		{"-0.124", 2, "-0.12", RuleDown},
		{"7.5075", 2, "7.51", RuleUp},
		{"0.005", 2, "0.00", RuleTieToEven},
		{"0.015", 2, "0.02", RuleTieToEven},
		{"59.97", 2, "59.97", RuleExact},
		{"1/3", 2, "0.33", RuleDown},
		{"2/3", 2, "0.67", RuleUp},
		{"-1/3", 2, "-0.33", RuleDown},
		{"123456789012345678901234567890.5", 0, "123456789012345678901234567890", RuleTieToEven},
	}
	for _, c := range cases {
		got, ev := RoundHalfEven(MustParse(c.in), c.scale)
		if s := got.Decimal(c.scale); s != c.want {
			t.Errorf("RoundHalfEven(%s, %d) = %s, want %s", c.in, c.scale, s, c.want)
		}
		if ev.Rule != c.rule {
			t.Errorf("RoundHalfEven(%s, %d) rule = %s, want %s", c.in, c.scale, ev.Rule, c.rule)
		}
		if ev.ExactN == "" || ev.ExactD == "" || ev.ScaledN == "" || ev.ScaledD == "" {
			t.Errorf("RoundHalfEven(%s, %d) evidence incomplete: %+v", c.in, c.scale, ev)
		}
	}
}

func TestDecimal(t *testing.T) {
	if s := MustParse("-1/200").Decimal(3); s != "-0.005" {
		t.Errorf("got %s", s)
	}
	if s := MustParse("7/2").Decimal(2); s != "3.50" {
		t.Errorf("got %s", s)
	}
	defer func() {
		if recover() == nil {
			t.Error("expected panic for non-representable scale")
		}
	}()
	MustParse("1/3").Decimal(2)
}
