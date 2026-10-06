package decimal

import (
	"fmt"
	"math/big"
	"math/rand"
	"strconv"
	"strings"
	"testing"
)

func TestQuantizeHalfEvenTable(t *testing.T) {
	cases := []struct {
		in    string
		scale int
		want  string
	}{
		{"0", 2, "0"},
		{"-0", 2, "0"},
		{"-0.000", 2, "0"},
		{"-0.0e500", 2, "0"},
		{"0.5", 0, "0"},
		{"1.5", 0, "2"},
		{"2.5", 0, "2"},
		{"3.5", 0, "4"},
		{"-0.5", 0, "0"},
		{"-1.5", 0, "-2"},
		{"-2.5", 0, "-2"},
		{"-3.5", 0, "-4"},
		{"1.005", 2, "100"},
		{"1.015", 2, "102"},
		{"2.675", 2, "268"},
		{"0.125", 2, "12"},
		{"0.135", 2, "14"},
		{"-1.005", 2, "-100"},
		{"-1.015", 2, "-102"},
		{"123.456", 2, "12346"},
		{"9.999", 0, "10"},
		{"-9.999", 0, "-10"},
		{"1e3", 2, "100000"},
		{"1.5e-3", 2, "0"},
		{"15e-1", 0, "2"},
		{"25e-1", 0, "2"},
		{"35e-1", 0, "4"},
		{"5e-1", 0, "0"},
		{"1e1000", 0, "1" + strings.Repeat("0", 1000)},
		{"1e-1000", 0, "0"},
		{"5e-1000", 0, "0"},
		{"15e-1000", 999, "2"}, // 1.5 at scale 999 -> 2
		{"123", -2, "1"},       // scale -2: 1.23 -> 1
		{"150", -2, "2"},       // 1.5 -> 2
		{"250", -2, "2"},       // 2.5 -> 2
	}
	for _, c := range cases {
		n, err := Parse(c.in)
		if err != nil {
			t.Fatalf("Parse(%q): %v", c.in, err)
		}
		got := Quantize(n, c.scale).String()
		if got != c.want {
			t.Errorf("Quantize(%q, %d) = %s, want %s", c.in, c.scale, got, c.want)
		}
	}
}

func TestParseExponentBounds(t *testing.T) {
	ok := []string{"1e1000", "1e-1000", "1E+1000", "0.5e1000", "9.99e-1000", "1e0", "1"}
	for _, s := range ok {
		if _, err := Parse(s); err != nil {
			t.Errorf("Parse(%q) unexpected error: %v", s, err)
		}
	}
	bad := []string{"1e1001", "1e-1001", "1E+1001", "1e99999999999999999999999", "1e-99999999999999999999999"}
	for _, s := range bad {
		if _, err := Parse(s); err == nil {
			t.Errorf("Parse(%q) expected out-of-range error, got nil", s)
		}
	}
}

func TestParseInvalidLiterals(t *testing.T) {
	bad := []string{"", "01", "1.", ".5", "+1", "1e", "1e+", "NaN", "Infinity", "0x10", "1_000", "--1", "1..2", "abc"}
	for _, s := range bad {
		if _, err := Parse(s); err == nil {
			t.Errorf("Parse(%q) expected error, got nil", s)
		}
	}
}

// decimalString renders num * 10^-frac exactly as a JSON decimal literal.
func decimalString(num int64, frac int) string {
	neg := num < 0
	if neg {
		num = -num
	}
	s := strconv.FormatInt(num, 10)
	for len(s) <= frac {
		s = "0" + s
	}
	if frac > 0 {
		s = s[:len(s)-frac] + "." + s[len(s)-frac:]
	}
	if neg {
		s = "-" + s
	}
	return s
}

// TestHalfValuesAgainstRational enumerates exact decimal half values
// (values whose scaled form ends exactly on .5) plus their +/-1 ulp
// neighbours, and checks Quantize against the rational reference.
func TestHalfValuesAgainstRational(t *testing.T) {
	for scale := 0; scale <= 6; scale++ {
		frac := scale + 1
		for k := int64(-400); k <= 400; k++ {
			// half value: (2k+1)*5 * 10^-(scale+1) == (k + 0.5) * 10^-scale
			half := (2*k + 1) * 5
			for _, delta := range []int64{-1, 0, 1} {
				lit := decimalString(half+delta, frac)
				checkAgainstReference(t, lit, scale)
			}
		}
	}
}

// TestHalfValuesWithExponentShift enumerates half values expressed with an
// explicit exponent field, verifying exact decimal exponent handling.
func TestHalfValuesWithExponentShift(t *testing.T) {
	for _, e := range []int{-1000, -17, -3, -1, 0, 1, 3, 17, 1000} {
		for _, k := range []int64{-101, -1, 0, 1, 2, 100} {
			for scale := 0; scale <= 3; scale++ {
				half := (2*k + 1) * 5
				lit := fmt.Sprintf("%sE%d", decimalString(half, scale+1), e)
				checkAgainstReference(t, lit, scale)
			}
		}
	}
}

func checkAgainstReference(t *testing.T, lit string, scale int) {
	t.Helper()
	n, err := Parse(lit)
	if err != nil {
		t.Fatalf("Parse(%q): %v", lit, err)
	}
	got := Quantize(n, scale)
	want := RoundRatHalfEven(n.Rat(), scale)
	if got.Cmp(want) != 0 {
		t.Fatalf("Quantize(%q, %d) = %s, rational reference = %s", lit, scale, got, want)
	}
}

// TestQuantizeFuzzAgainstRational checks random literals with random scales
// and exponents against the rational reference.
func TestQuantizeFuzzAgainstRational(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for i := 0; i < 5000; i++ {
		var b strings.Builder
		if rng.Intn(2) == 0 {
			b.WriteByte('-')
		}
		intDigits := 1 + rng.Intn(20)
		b.WriteByte(byte('1' + rng.Intn(9)))
		for j := 1; j < intDigits; j++ {
			b.WriteByte(byte('0' + rng.Intn(10)))
		}
		if rng.Intn(2) == 0 {
			b.WriteByte('.')
			fracDigits := 1 + rng.Intn(20)
			for j := 0; j < fracDigits; j++ {
				b.WriteByte(byte('0' + rng.Intn(10)))
			}
		}
		if rng.Intn(2) == 0 {
			b.WriteByte('e')
			fmt.Fprintf(&b, "%+d", rng.Intn(2001)-1000)
		}
		lit := b.String()
		scale := rng.Intn(41) - 20
		checkAgainstReference(t, lit, scale)
	}
}

// TestNegativeZero ensures any zero literal, however written, yields "0".
func TestNegativeZero(t *testing.T) {
	for _, lit := range []string{"-0", "-0.0", "-0.000e-1000", "-0e1000", "0", "0.0e5", "-0.004", "-0.005"} {
		n, err := Parse(lit)
		if err != nil {
			t.Fatalf("Parse(%q): %v", lit, err)
		}
		if got := Quantize(n, 2).String(); got != "0" {
			t.Errorf("Quantize(%q, 2) = %q, want %q", lit, got, "0")
		}
	}
}

// TestRatRoundTrip checks Rat against a plain big.Rat construction.
func TestRatRoundTrip(t *testing.T) {
	n, err := Parse("-12.34e2")
	if err != nil {
		t.Fatal(err)
	}
	want := big.NewRat(-1234, 1)
	if n.Rat().Cmp(want) != 0 {
		t.Fatalf("Rat() = %v, want %v", n.Rat(), want)
	}
}
