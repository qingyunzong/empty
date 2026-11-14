package dataeng

import (
	"math/big"
	"strings"
	"testing"
)

func mustDims(t *testing.T, expr string, want Dimension) {
	t.Helper()
	e, err := Parse(expr)
	if err != nil {
		t.Fatalf("Parse(%q) error: %v", expr, err)
	}
	if e.Dims != want {
		t.Fatalf("Parse(%q) dims = %v, want %v", expr, e.Dims, want)
	}
}

func mustScale(t *testing.T, expr, want string) {
	t.Helper()
	e, err := Parse(expr)
	if err != nil {
		t.Fatalf("Parse(%q) error: %v", expr, err)
	}
	w, _ := new(big.Rat).SetString(want)
	if e.Scale.Cmp(w) != 0 {
		t.Fatalf("Parse(%q) scale = %s, want %s", expr, e.Scale.RatString(), w.RatString())
	}
}

func TestParseCompound(t *testing.T) {
	mustDims(t, "kg*m/s^2", dimM.Add(dimL).Add(dimT.Pow(-2)))
	mustScale(t, "kg*m/s^2", "1")
	mustDims(t, "m/s", dimL.Sub(dimT))
	mustDims(t, "N*m", dimM.Add(dimL.Pow(2)).Add(dimT.Pow(-2)))
	mustDims(t, "(m/s)^2", dimL.Pow(2).Sub(dimT.Pow(2)))
	mustScale(t, "1/s", "1")
}

func TestLongestMatch(t *testing.T) {
	mustScale(t, "mm", "1/1000")
	mustScale(t, "min", "60")
	mustScale(t, "mK", "1/1000")
	mustScale(t, "kg", "1")
	mustScale(t, "cd", "1")
	mustScale(t, "km/h", "5/18")
	mustScale(t, "mL", "1/1000000")
	mustScale(t, "dam", "10")
	mustScale(t, "Ts", "1000000000000")
	mustScale(t, "T", "1")
	mustDims(t, "kilometer/hour", dimL.Sub(dimT))
	mustScale(t, "millimeter", "1/1000")
}

func TestPowerSyntax(t *testing.T) {
	mustDims(t, "m^2", dimL.Pow(2))
	mustDims(t, "m**2", dimL.Pow(2))
	mustDims(t, "m2", dimL.Pow(2))
	mustDims(t, "m²", dimL.Pow(2))
	mustDims(t, "s^-1", dimT.Pow(-1))
	mustDims(t, "s⁻¹", dimT.Pow(-1))
	mustScale(t, "cm^3", "1/1000000")
}

func TestUnknownSymbolPosition(t *testing.T) {
	_, err := Parse("m/xyz")
	ue, ok := err.(*Error)
	if !ok {
		t.Fatalf("expected *Error, got %T", err)
	}
	if ue.Pos != 2 || ue.End != 5 {
		t.Fatalf("error span = [%d,%d), want [2,5)", ue.Pos, ue.End)
	}
	if !strings.Contains(ue.Msg, `"xyz"`) {
		t.Fatalf("error message %q should name the unknown symbol", ue.Msg)
	}
}

func TestAffineRestrictions(t *testing.T) {
	e, err := Parse("°C")
	if err != nil {
		t.Fatalf("Parse(°C) error: %v", err)
	}
	if !e.Affine() {
		t.Fatal("°C should be affine")
	}
	for _, bad := range []string{"°C^2", "°C/s", "m*°F", "°F*°F", "°C·m"} {
		if _, err := Parse(bad); err == nil {
			t.Fatalf("Parse(%q) should reject affine composition", bad)
		} else if ue, ok := err.(*Error); !ok || ue.Pos < 0 {
			t.Fatalf("Parse(%q) error should carry a position, got %v", bad, err)
		}
	}
}

func TestParseErrors(t *testing.T) {
	for _, bad := range []string{"", "m/", "*m", "(m", "m)", "m^", "m^x"} {
		if _, err := Parse(bad); err == nil {
			t.Fatalf("Parse(%q) should fail", bad)
		}
	}
}
