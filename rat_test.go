package recipe

import (
	"encoding/json"
	"testing"
)

func TestRatCrossMultiplicationCompare(t *testing.T) {
	// 1/3 vs 333/1000: 1000 > 999, so 1/3 is larger.
	if NewRat(1, 3).Cmp(NewRat(333, 1000)) <= 0 {
		t.Fatal("1/3 should exceed 333/1000")
	}
	// 2/4 reduces to 1/2 and must compare equal.
	if NewRat(2, 4).Cmp(NewRat(1, 2)) != 0 {
		t.Fatal("2/4 should equal 1/2")
	}
	// Negative denominators normalize: 1/-2 == -1/2 < 0.
	if NewRat(1, -2).Cmp(Zero()) >= 0 {
		t.Fatal("1/-2 should be negative")
	}
	if NewRat(-3, -4).Cmp(NewRat(3, 4)) != 0 {
		t.Fatal("-3/-4 should equal 3/4")
	}
}

func TestRatArithmeticExact(t *testing.T) {
	sum := NewRat(1, 2).Add(NewRat(1, 3))
	if sum.Cmp(NewRat(5, 6)) != 0 || sum.String() != "5/6" {
		t.Fatalf("1/2+1/3 = %s, want 5/6", sum)
	}
	prod := NewRat(2, 3).Mul(NewRat(9, 4))
	if prod.Cmp(NewRat(3, 2)) != 0 {
		t.Fatalf("2/3*9/4 = %s, want 3/2", prod)
	}
	q := NewRat(1, 2).Div(NewRat(1, 4))
	if q.Cmp(RatFromInt(2)) != 0 {
		t.Fatalf("(1/2)/(1/4) = %s, want 2", q)
	}
	// Exactness where floats fail: 1/3*3 == 1 precisely.
	if NewRat(1, 3).MulInt(3).Cmp(RatFromInt(1)) != 0 {
		t.Fatal("1/3 * 3 should be exactly 1")
	}
}

func TestRatParseAndJSON(t *testing.T) {
	for _, s := range []string{"3/2", "2", "0.5", "-7/4", "1e2"} {
		r, err := ParseRat(s)
		if err != nil {
			t.Fatalf("ParseRat(%q): %v", s, err)
		}
		data, err := json.Marshal(r)
		if err != nil {
			t.Fatal(err)
		}
		var back Rat
		if err := json.Unmarshal(data, &back); err != nil {
			t.Fatal(err)
		}
		if back.Cmp(r) != 0 {
			t.Fatalf("JSON roundtrip of %q gave %s", s, back)
		}
	}
	half, _ := ParseRat("0.5")
	if half.Cmp(NewRat(1, 2)) != 0 {
		t.Fatalf("0.5 parsed as %s", half)
	}
	if _, err := ParseRat("x/y"); err == nil {
		t.Fatal("invalid rational should fail to parse")
	}
}
