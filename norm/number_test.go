package norm

import (
	"math/big"
	"strings"
	"testing"
)

func TestCanonicalNumber(t *testing.T) {
	cases := []struct{ in, want string }{
		{"0", "0"},
		{"-0", "0"},
		{"0.0", "0"},
		{"-0.00e10", "0"},
		{"0e0", "0"},
		{"1", "1"},
		{"-1", "-1"},
		{"10", "10"},
		{"100", "100"},
		{"1.50", "1.5"},
		{"1.5000", "1.5"},
		{"123.456", "123.456"},
		{"1e2", "100"},
		{"1E+2", "100"},
		{"1e-2", "0.01"},
		{"0.1", "0.1"},
		{"0.007", "0.007"},
		{"1.23e5", "123000"},
		{"1.50e1", "15"},
		{"5e-10", "0.0000000005"},
		{"5e-11", "0.00000000005"},
		{"5e-12", "5e-12"},
		{"1e49", "1" + strings.Repeat("0", 49)},
		{"1e50", "1e+50"},
		{"1.5e60", "1.5e+60"},
		{"-2.5e-30", "-2.5e-30"},
		{"9007199254740993", "9007199254740993"},
		{"0.30000000000000004", "0.30000000000000004"},
		{"123456789012345678901234567890.123456789", "123456789012345678901234567890.123456789"},
		{"1e123456789123456789", "1e+123456789123456789"},
		{"1.0000000000000000001", "1.0000000000000000001"},
	}
	for _, c := range cases {
		got, err := canonicalNumber(c.in)
		if err != nil {
			t.Errorf("canonicalNumber(%q): %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("canonicalNumber(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestCanonicalNumberInvalid(t *testing.T) {
	for _, in := range []string{
		"", "-", "+1", "01", "00", "1.", ".1", "1e", "1e+", "1e-", "0x1",
		"1..2", "1.2.3", "--1", "1e1.5", "1 ", " 1", "1a", "NaN", "Infinity",
	} {
		if got, err := canonicalNumber(in); err == nil {
			t.Errorf("canonicalNumber(%q) = %q, want error", in, got)
		}
	}
}

// The canonical form must preserve the exact decimal value.
func TestCanonicalNumberPreservesValue(t *testing.T) {
	for _, in := range []string{
		"1.50", "1e2", "0.1", "123.456e-3", "9007199254740993",
		"0.30000000000000004", "1e100", "2.5e-30", "10", "0.000",
	} {
		canon, err := canonicalNumber(in)
		if err != nil {
			t.Fatalf("canonicalNumber(%q): %v", in, err)
		}
		a, okA := new(big.Rat).SetString(in)
		b, okB := new(big.Rat).SetString(canon)
		if !okA || !okB {
			t.Fatalf("cannot parse %q or %q", in, canon)
		}
		if a.Cmp(b) != 0 {
			t.Errorf("canonicalNumber(%q) = %q changes the decimal value", in, canon)
		}
	}
}
