package dataeng

import (
	"math/big"
	"testing"
)

func mustConvert(t *testing.T, value, from, to string) *big.Rat {
	t.Helper()
	v, _ := new(big.Rat).SetString(value)
	fe, err := Parse(from)
	if err != nil {
		t.Fatalf("Parse(%q): %v", from, err)
	}
	te, err := Parse(to)
	if err != nil {
		t.Fatalf("Parse(%q): %v", to, err)
	}
	r, err := Convert(v, fe, te)
	if err != nil {
		t.Fatalf("Convert(%s %s -> %s): %v", value, from, to, err)
	}
	return r
}

func expectRat(t *testing.T, got *big.Rat, want string) {
	t.Helper()
	w, _ := new(big.Rat).SetString(want)
	if got.Cmp(w) != 0 {
		t.Fatalf("got %s, want %s", got.RatString(), w.RatString())
	}
}

func TestConvertLinear(t *testing.T) {
	expectRat(t, mustConvert(t, "1", "km", "m"), "1000")
	expectRat(t, mustConvert(t, "1", "m/s", "km/h"), "18/5")
	expectRat(t, mustConvert(t, "1", "kW*h", "J"), "3600000")
	expectRat(t, mustConvert(t, "2.5", "cm^2", "m^2"), "1/4000")
}

func TestConvertAffine(t *testing.T) {
	expectRat(t, mustConvert(t, "0", "°C", "°F"), "32")
	expectRat(t, mustConvert(t, "100", "°C", "°F"), "212")
	expectRat(t, mustConvert(t, "32", "°F", "°C"), "0")
	expectRat(t, mustConvert(t, "273.15", "K", "°C"), "0")
	expectRat(t, mustConvert(t, "-40", "°C", "°F"), "-40")
}

func TestDimensionMismatchRejected(t *testing.T) {
	v := ratInt(1)
	m := MustParse("m")
	s := MustParse("s")
	if _, err := Convert(v, m, s); err == nil {
		t.Fatal("m -> s should be rejected")
	}
}

func TestConvertStringDecimal(t *testing.T) {
	got, err := ConvertString("1.5", "km", "m", Exact())
	if err != nil {
		t.Fatal(err)
	}
	if got != "1500" {
		t.Fatalf("got %q, want 1500", got)
	}
	got, err = ConvertString("1", "m", "cm", Fixed(2))
	if err != nil {
		t.Fatal(err)
	}
	if got != "100.00" {
		t.Fatalf("got %q, want 100.00", got)
	}
}

func TestRoundTripExact(t *testing.T) {
	for _, tc := range [][2]string{
		{"m", "mm"},
		{"°C", "°F"},
		{"°C", "K"},
		{"kg*m/s^2", "N"},
		{"km/h", "m/s"},
	} {
		back, errVal, err := RoundTrip("1.234567", tc[0], tc[1], Exact())
		if err != nil {
			t.Fatalf("RoundTrip(%s -> %s): %v", tc[0], tc[1], err)
		}
		if errVal.Sign() != 0 {
			t.Fatalf("RoundTrip(%s -> %s) error = %s, want 0 (got %s)", tc[0], tc[1], errVal.RatString(), back)
		}
	}
}

func TestRoundTripFixedBounded(t *testing.T) {
	p := Fixed(4)
	from := MustParse("m")
	to := MustParse("mm")
	bound, err := RoundTripBound(from, to, p)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"0.001", "1.23456789", "999.99995", "123456.789123"} {
		_, errVal, err := RoundTrip(value, "m", "mm", p)
		if err != nil {
			t.Fatal(err)
		}
		if errVal.Cmp(bound) > 0 {
			t.Fatalf("round-trip error %s exceeds bound %s for %s", errVal.RatString(), bound.RatString(), value)
		}
	}
}

func TestRoundTripBoundExactIsZero(t *testing.T) {
	bound, err := RoundTripBound(MustParse("°C"), MustParse("°F"), Exact())
	if err != nil {
		t.Fatal(err)
	}
	if bound.Sign() != 0 {
		t.Fatalf("exact bound = %s, want 0", bound.RatString())
	}
}
