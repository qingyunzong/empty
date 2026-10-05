package interval

import "testing"

func TestAddSub(t *testing.T) {
	x := New(Rat(1, 2), Rat(3, 2))
	y := New(Rat(-1, 1), Rat(2, 1))
	got := x.Add(y)
	if got.Lo.Cmp(Rat(-1, 2)) != 0 || got.Hi.Cmp(Rat(7, 2)) != 0 {
		t.Fatalf("add: got %v", got)
	}
	got = x.Sub(y)
	if got.Lo.Cmp(Rat(-3, 2)) != 0 || got.Hi.Cmp(Rat(5, 2)) != 0 {
		t.Fatalf("sub: got %v", got)
	}
}

func TestMul(t *testing.T) {
	got := New(Rat(-2, 1), Rat(3, 1)).Mul(New(Rat(-4, 1), Rat(5, 1)))
	if got.Lo.Cmp(Rat(-12, 1)) != 0 || got.Hi.Cmp(Rat(15, 1)) != 0 {
		t.Fatalf("mul: got %v", got)
	}
}

func TestDiv(t *testing.T) {
	got := New(Rat(1, 1), Rat(2, 1)).Div(New(Rat(3, 1), Rat(4, 1)))
	if got.Undef || got.Lo.Cmp(Rat(1, 4)) != 0 || got.Hi.Cmp(Rat(2, 3)) != 0 {
		t.Fatalf("div: got %v", got)
	}
}

func TestDivByZeroContainingInterval(t *testing.T) {
	x := New(Rat(1, 1), Rat(2, 1))
	for _, d := range []Interval{
		New(Rat(-1, 1), Rat(2, 1)), // straddles zero
		New(Rat(0, 1), Rat(5, 1)),  // touches zero
		Point(Rat(0, 1)),           // zero point
		Undefined(),                // undefined divisor
	} {
		if got := x.Div(d); !got.Undef {
			t.Fatalf("div by %v: want undef, got %v", d, got)
		}
	}
}

func TestUndefPropagates(t *testing.T) {
	u := Undefined()
	x := New(Rat(1, 1), Rat(2, 1))
	if !x.Add(u).Undef || !x.Sub(u).Undef || !x.Mul(u).Undef || !u.Div(x).Undef {
		t.Fatal("undef must propagate through arithmetic")
	}
}

func TestHull(t *testing.T) {
	got := Hull(New(Rat(0, 1), Rat(1, 1)), New(Rat(2, 1), Rat(3, 1)))
	if got.Lo.Cmp(Rat(0, 1)) != 0 || got.Hi.Cmp(Rat(3, 1)) != 0 {
		t.Fatalf("hull: got %v", got)
	}
	if !Hull(Undefined(), Undefined()).Undef {
		t.Fatal("hull of two undefs must be undef")
	}
}
