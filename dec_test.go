package main

import (
	"fmt"
	"math/big"
	"math/rand"
	"strconv"
	"strings"
	"testing"
)

func mustParse(t *testing.T, s string) Dec {
	t.Helper()
	d, err := Parse(s)
	if err != nil {
		t.Fatalf("Parse(%q): %v", s, err)
	}
	return d
}

func TestParseQuantizeTable(t *testing.T) {
	cases := []struct {
		in    string
		scale int
		want  string
	}{
		{"1.005", 2, "100"},   // 100.5 ties to even
		{"2.675", 2, "268"},   // 267.5 ties to even
		{"1.0049", 2, "100"},  // just below half
		{"1.0051", 2, "101"},  // just above half
		{"-1.005", 2, "-100"}, // symmetric
		{"-2.675", 2, "-268"},
		{"0.5", 0, "0"},   // ties to even
		{"1.5", 0, "2"},   // ties to even
		{"2.5", 0, "2"},   // ties to even
		{"-0.5", 0, "0"},  // ties to even
		{"-1.5", 0, "-2"}, // ties to even
		{"1e3", 2, "100000"},
		{"1.5e3", 0, "1500"},
		{"1.234e-2", 4, "123"},
		{"123456789012345678901234567890.5", 0, "123456789012345678901234567890"},
		{"0.000", 2, "0"},
		{"-0", 2, "0"},      // negative zero -> zero
		{"-0.0", 2, "0"},    // negative zero -> zero
		{"-0.004", 2, "0"},  // rounds to zero, never "-0"
		{"-0.0001", 2, "0"}, // rounds to zero, never "-0"
		{"1e1000", 0, "1" + strings.Repeat("0", 1000)},
		{"1e-1000", 1000, "1"},
		{"9.99", 1, "100"},
		{"-9.99", 1, "-100"},
	}
	for _, c := range cases {
		d := mustParse(t, c.in)
		got := d.Quantize(c.scale).String()
		if got != c.want {
			t.Errorf("Quantize(%q, %d) = %s, want %s", c.in, c.scale, got, c.want)
		}
	}
}

func TestParseRejectsInvalid(t *testing.T) {
	for _, s := range []string{
		"", "abc", "1.2.3", "1e", "1e+", ".5", "1.", "01", "--1",
		"1,000", "NaN", "Infinity", "0x10", "1e1.5", "+1",
	} {
		if _, err := Parse(s); err == nil {
			t.Errorf("Parse(%q) succeeded, want error", s)
		}
	}
}

func TestExponentRange(t *testing.T) {
	ok := []string{"1e1000", "1e-1000", "1.5e999", "12e999", "0.5e-999", "1E1000", "1e+1000"}
	for _, s := range ok {
		if _, err := Parse(s); err != nil {
			t.Errorf("Parse(%q) = %v, want ok", s, err)
		}
	}
	bad := []string{
		"1e1001", "1e-1001", "1.5e1002", "0.05e-1000", // combined exponent out of range
		"1e9999999999999999999999", "1e-9999999999999999999999", // exponent literal overflow
	}
	for _, s := range bad {
		if _, err := Parse(s); err == nil {
			t.Errorf("Parse(%q) succeeded, want out-of-range error", s)
		}
	}
}

// halfString returns the exact decimal string of (2m+1)/2 * 10^-scale,
// i.e. a value sitting exactly on a rounding boundary at the given scale.
func halfString(m, scale int) string {
	units := (2*m + 1) * 5
	frac := scale + 1
	neg := units < 0
	if neg {
		units = -units
	}
	digits := strconv.Itoa(units)
	for len(digits) <= frac {
		digits = "0" + digits
	}
	s := digits[:len(digits)-frac] + "." + digits[len(digits)-frac:]
	if neg {
		s = "-" + s
	}
	return s
}

// TestHalfEvenEnumeration enumerates exact decimal half values at several
// scales and checks Quantize against the rational reference, plus the
// closed-form ties-to-even expectation.
func TestHalfEvenEnumeration(t *testing.T) {
	for scale := 0; scale <= 4; scale++ {
		for m := -150; m <= 150; m++ {
			s := halfString(m, scale)
			d := mustParse(t, s)
			got := d.Quantize(scale)
			ref := RoundHalfEvenRat(new(big.Rat).Mul(d.Rat(), new(big.Rat).SetInt(pow10(scale))))
			if got.Cmp(ref) != 0 {
				t.Fatalf("Quantize(%q, %d) = %s, rational reference = %s", s, scale, got, ref)
			}
			// Closed form: value is m+0.5 in target units; ties go to even.
			want := m
			if m%2 != 0 {
				want = m + 1
			}
			if got.Cmp(big.NewInt(int64(want))) != 0 {
				t.Fatalf("Quantize(%q, %d) = %s, closed form = %d", s, scale, got, want)
			}
		}
	}
}

// TestQuantizeVsRational cross-checks random decimals against the exact
// rational reference at random scales.
func TestQuantizeVsRational(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for i := 0; i < 5000; i++ {
		s := randomLiteral(rng)
		d := mustParse(t, s)
		scale := rng.Intn(9) - 2
		got := d.Quantize(scale)
		want := QuantizeRat(d.Rat(), scale)
		if got.Cmp(want) != 0 {
			t.Fatalf("Quantize(%q, %d) = %s, rational reference = %s", s, scale, got, want)
		}
		if got.Sign() == 0 && got.String() != "0" {
			t.Fatalf("Quantize(%q, %d) produced negative zero %q", s, scale, got)
		}
	}
}

// randomLiteral builds a random valid JSON number literal with a bounded
// exponent.
func randomLiteral(rng *rand.Rand) string {
	var b strings.Builder
	if rng.Intn(2) == 0 {
		b.WriteByte('-')
	}
	intDigits := 1 + rng.Intn(20)
	b.WriteByte(byte('1' + rng.Intn(9)))
	for i := 1; i < intDigits; i++ {
		b.WriteByte(byte('0' + rng.Intn(10)))
	}
	if rng.Intn(2) == 0 {
		fracDigits := 1 + rng.Intn(12)
		b.WriteByte('.')
		for i := 0; i < fracDigits; i++ {
			b.WriteByte(byte('0' + rng.Intn(10)))
		}
	}
	if rng.Intn(3) == 0 {
		fmt.Fprintf(&b, "e%+d", rng.Intn(41)-20)
	}
	return b.String()
}

func TestConvertAllKeepsPositions(t *testing.T) {
	lits := []string{"1.5", "1e1001", "2.5", "bogus", "3.5"}
	out, errs := ConvertAll(lits, 0)
	if len(errs) != 2 {
		t.Fatalf("got %d errors, want 2", len(errs))
	}
	if errs[0].Index != 1 || errs[1].Index != 3 {
		t.Fatalf("error positions = %d, %d; want 1, 3", errs[0].Index, errs[1].Index)
	}
	for _, i := range []int{0, 2, 4} {
		if out[i] == nil {
			t.Fatalf("position %d lost: got nil result", i)
		}
	}
	if out[0].String() != "2" || out[2].String() != "2" || out[4].String() != "4" {
		t.Fatalf("wrong values: %v %v %v", out[0], out[2], out[4])
	}
}
