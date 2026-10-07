package decimal

import (
	"errors"
	"math/big"
	"math/rand"
	"testing"
)

func TestParse(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"0", "0"},
		{"42", "42"},
		{"-7", "-7"},
		{"+3.5", "3.5"},
		{"1.25", "1.25"},
		{"-0.001", "-0.001"},
		{".5", "0.5"},
		{"5.", "5"},
		{"1.50", "1.5"},
		{"1.5e3", "1500"},
		{"1.5E+3", "1500"},
		{"2.5e-2", "0.025"},
		{"-1.25e2", "-125"},
		{"6.022e23", "602200000000000000000000"},
		{"1e-10", "0.0000000001"},
		{"12345678901234567890.0987654321", "12345678901234567890.0987654321"},
		// Negative zero collapses to zero.
		{"-0", "0"},
		{"-0.000", "0"},
		{"-0e5", "0"},
		{"-0.0e-3", "0"},
	}
	for _, c := range cases {
		got, err := Parse(c.in)
		if err != nil {
			t.Errorf("Parse(%q) error: %v", c.in, err)
			continue
		}
		if got.String() != c.want {
			t.Errorf("Parse(%q) = %q, want %q", c.in, got.String(), c.want)
		}
	}
}

func TestParseErrors(t *testing.T) {
	for _, in := range []string{"", "abc", "1.2.3", "1e", "e5", ".", "-", "1e+", "1.2e100000", "--1", "1..2"} {
		if _, err := Parse(in); err == nil {
			t.Errorf("Parse(%q) expected error, got nil", in)
		}
	}
}

func TestRoundHalfEven(t *testing.T) {
	cases := []struct {
		in   string
		prec uint32
		want string
	}{
		// Exact halves round to the even neighbor.
		{"0.5", 0, "0"},
		{"1.5", 0, "2"},
		{"2.5", 0, "2"},
		{"3.5", 0, "4"},
		{"-0.5", 0, "0"},
		{"-1.5", 0, "-2"},
		{"-2.5", 0, "-2"},
		{"0.125", 2, "0.12"},
		{"0.135", 2, "0.14"},
		{"0.115", 2, "0.12"},
		{"2.675", 2, "2.68"},
		// Non-ties round to nearest.
		{"0.124", 2, "0.12"},
		{"0.126", 2, "0.13"},
		{"1.005", 2, "1"},
		{"9.999", 2, "10"},
		// Already at or below requested precision: unchanged.
		{"1.5", 2, "1.5"},
		{"1.5", 5, "1.5"},
		{"1500", 2, "1500"},
		// Negative results that round to zero become positive zero.
		{"-0.004", 2, "0"},
		{"-0.0001", 3, "0"},
	}
	for _, c := range cases {
		got := MustParse(c.in).Round(c.prec)
		if got.String() != c.want {
			t.Errorf("Round(%q, %d) = %q, want %q", c.in, c.prec, got.String(), c.want)
		}
	}
}

func TestQuo(t *testing.T) {
	cases := []struct {
		a, b string
		prec uint32
		want string
	}{
		{"1", "3", 10, "0.3333333333"},
		{"2", "3", 10, "0.6666666667"},
		{"1", "8", 2, "0.12"}, // 0.125 -> half to even
		{"3", "8", 2, "0.38"}, // 0.375 -> half to even
		{"1", "2", 0, "0"},    // 0.5 -> 0
		{"3", "2", 0, "2"},    // 1.5 -> 2
		{"5", "2", 0, "2"},    // 2.5 -> 2
		{"7", "2", 0, "4"},    // 3.5 -> 4
		{"-1", "2", 0, "0"},   // -0.5 -> 0 (no negative zero)
		{"-3", "2", 0, "-2"},
		{"10", "4", 2, "2.5"},
		{"1", "7", 6, "0.142857"},
		{"-1", "7", 6, "-0.142857"},
		{"1", "-7", 6, "-0.142857"},
		{"-1", "-7", 6, "0.142857"},
		{"0", "5", 4, "0"},
		{"-0.004", "1", 2, "0"}, // rounds to zero, not negative zero
		{"123456789", "1000000007", 20, "0.12345678813580248305"},
	}
	for _, c := range cases {
		got, err := MustParse(c.a).Quo(MustParse(c.b), c.prec)
		if err != nil {
			t.Errorf("Quo(%q, %q, %d) error: %v", c.a, c.b, c.prec, err)
			continue
		}
		if got.String() != c.want {
			t.Errorf("Quo(%q, %q, %d) = %q, want %q", c.a, c.b, c.prec, got.String(), c.want)
		}
	}
}

func TestQuoByZero(t *testing.T) {
	for _, z := range []string{"0", "-0", "0.000", "-0.0e3"} {
		_, err := MustParse("1.5").Quo(MustParse(z), 10)
		if !errors.Is(err, ErrDivisionByZero) {
			t.Errorf("1.5 / %q: err = %v, want ErrDivisionByZero", z, err)
		}
	}
	// Zero divided by non-zero is zero.
	got, err := MustParse("0").Quo(MustParse("3.7"), 5)
	if err != nil || got.String() != "0" {
		t.Errorf("0 / 3.7 = %q, %v; want \"0\", nil", got.String(), err)
	}
}

func TestExactArithmetic(t *testing.T) {
	// Add/Sub/Mul are exact: no rounding anywhere.
	a := MustParse("123456789.987654321")
	b := MustParse("0.000000001")
	if got := a.Add(b).String(); got != "123456789.987654322" {
		t.Errorf("Add = %q", got)
	}
	if got := a.Sub(b).String(); got != "123456789.98765432" {
		t.Errorf("Sub = %q", got)
	}
	c := MustParse("1.0000000001")
	if got := c.Mul(c).String(); got != "1.00000000020000000001" {
		t.Errorf("Mul = %q", got)
	}
	// Zero handling.
	zero := MustParse("0")
	if got := zero.Add(MustParse("-0.00")).String(); got != "0" {
		t.Errorf("0 + -0.00 = %q", got)
	}
	if got := MustParse("-2.5").Mul(zero).String(); got != "0" {
		t.Errorf("-2.5 * 0 = %q, want 0 (no negative zero)", got)
	}
}

func TestCmp(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.5", "1.50", 0},
		{"-0", "0", 0},
		{"1.5e1", "15", 0},
		{"0.1", "0.09", 1},
		{"-2", "-1.999", -1},
		{"1e-30", "0", 1},
	}
	for _, c := range cases {
		if got := MustParse(c.a).Cmp(MustParse(c.b)); got != c.want {
			t.Errorf("Cmp(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

// --- Reference verification against math/big.Rat ---

func ratOf(t *testing.T, d Decimal) *big.Rat {
	t.Helper()
	coef, scale := d.Coef()
	r := new(big.Rat).SetInt(coef)
	p := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale)), nil)
	if scale >= 0 {
		r.Quo(r, new(big.Rat).SetInt(p))
	} else {
		r.Mul(r, new(big.Rat).SetInt(p))
	}
	return r
}

// roundRatHalfEven rounds r to prec fractional decimal digits, half to even.
func roundRatHalfEven(r *big.Rat, prec uint32) *big.Rat {
	p := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(prec)), nil)
	scaled := new(big.Rat).Mul(r, new(big.Rat).SetInt(p))
	num, den := scaled.Num(), scaled.Denom()
	sign := num.Sign()
	n := new(big.Int).Abs(num)
	q, rem := new(big.Int).QuoRem(n, den, new(big.Int))
	double := new(big.Int).Lsh(rem, 1)
	switch double.Cmp(den) {
	case 1:
		q.Add(q, big.NewInt(1))
	case 0:
		if q.Bit(0) == 1 {
			q.Add(q, big.NewInt(1))
		}
	}
	if sign < 0 {
		q.Neg(q)
	}
	return new(big.Rat).SetFrac(q, p)
}

func randDecimal(r *rand.Rand) Decimal {
	coef := r.Int63n(2_000_000_000) - 1_000_000_000
	scale := int32(r.Intn(13)) // 0..12 fractional digits
	return New(coef, scale)
}

// TestChainedOpsAgainstRat verifies chains of exact operations followed by a
// single final rounding (division or Round) against a big.Rat reference that
// is rounded only at the very end.
func TestChainedOpsAgainstRat(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	const prec = 6
	for i := 0; i < 2000; i++ {
		a, b, c, d := randDecimal(r), randDecimal(r), randDecimal(r), randDecimal(r)

		// ((a + b) * c - d), rounded once at the end.
		got := a.Add(b).Mul(c).Sub(d).Round(prec)
		want := roundRatHalfEven(new(big.Rat).Sub(
			new(big.Rat).Mul(
				new(big.Rat).Add(ratOf(t, a), ratOf(t, b)),
				ratOf(t, c)),
			ratOf(t, d)), prec)
		if gr := ratOf(t, got); gr.Cmp(want) != 0 {
			t.Fatalf("iter %d: chain round = %s (%s), want %s",
				i, got.String(), gr.FloatString(20), want.FloatString(20))
		}

		// ((a * b) - (c + d)) / e with a single final division rounding.
		e := randDecimal(r)
		if e.Sign() == 0 {
			e = New(1, 0)
		}
		gotQ, err := a.Mul(b).Sub(c.Add(d)).Quo(e, prec)
		if err != nil {
			t.Fatalf("iter %d: unexpected error: %v", i, err)
		}
		wantQ := roundRatHalfEven(new(big.Rat).Quo(
			new(big.Rat).Sub(
				new(big.Rat).Mul(ratOf(t, a), ratOf(t, b)),
				new(big.Rat).Add(ratOf(t, c), ratOf(t, d))),
			ratOf(t, e)), prec)
		if gr := ratOf(t, gotQ); gr.Cmp(wantQ) != 0 {
			t.Fatalf("iter %d: chain quo = %s (%s), want %s",
				i, gotQ.String(), gr.FloatString(20), wantQ.FloatString(20))
		}
	}
}

// TestHalfValuesAgainstRat verifies half-even rounding of exact halves and
// near-halves produced by division, against the big.Rat reference.
func TestHalfValuesAgainstRat(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	for i := 0; i < 2000; i++ {
		// Build a value whose quotient at scale k is an exact half:
		// num/den = integer + 0.5 * 10^-prec.
		prec := uint32(r.Intn(8))
		intPart := r.Int63n(2_000_000) - 1_000_000
		// value = intPart + 5 * 10^-(prec+1), divided by 1.
		half := New(intPart, 0).Add(New(5, int32(prec)+1))
		got, err := half.Quo(New(1, 0), prec)
		if err != nil {
			t.Fatalf("iter %d: unexpected error: %v", i, err)
		}
		want := roundRatHalfEven(ratOf(t, half), prec)
		if gr := ratOf(t, got); gr.Cmp(want) != 0 {
			t.Fatalf("iter %d: half %s at prec %d = %s, want %s",
				i, half.String(), prec, gr.FloatString(20), want.FloatString(20))
		}

		// Also perturb slightly above and below the half.
		delta := New(1, int32(prec)+4)
		for _, v := range []Decimal{half.Sub(delta), half.Add(delta)} {
			gotV, err := v.Quo(New(1, 0), prec)
			if err != nil {
				t.Fatalf("iter %d: unexpected error: %v", i, err)
			}
			wantV := roundRatHalfEven(ratOf(t, v), prec)
			if gr := ratOf(t, gotV); gr.Cmp(wantV) != 0 {
				t.Fatalf("iter %d: near-half %s at prec %d = %s, want %s",
					i, v.String(), prec, gr.FloatString(20), wantV.FloatString(20))
			}
		}
	}
}

// TestRoundAgainstRat fuzzes Round against the rational reference.
func TestRoundAgainstRat(t *testing.T) {
	r := rand.New(rand.NewSource(99))
	for i := 0; i < 5000; i++ {
		d := randDecimal(r)
		prec := uint32(r.Intn(10))
		got := d.Round(prec)
		want := roundRatHalfEven(ratOf(t, d), prec)
		if gr := ratOf(t, got); gr.Cmp(want) != 0 {
			t.Fatalf("iter %d: Round(%s, %d) = %s, want %s",
				i, d.String(), prec, gr.FloatString(20), want.FloatString(20))
		}
		if got.Sign() == 0 && got.String() != "0" {
			t.Fatalf("iter %d: zero result %q not normalized", i, got.String())
		}
	}
}
