package poly

import (
	"math/big"
	"math/rand"
	"testing"
)

func rat(n int64) *big.Rat { return big.NewRat(n, 1) }

func randomPoly(r *rand.Rand, maxTerms int, maxExp uint16, maxCoeff int64) *Poly {
	p := Zero()
	n := 1 + r.Intn(maxTerms)
	for i := 0; i < n; i++ {
		var m Mono
		for j := range m {
			m[j] = uint16(r.Intn(int(maxExp) + 1))
		}
		c := r.Int63n(2*maxCoeff+1) - maxCoeff
		if c == 0 {
			c = 1
		}
		p.terms[m] = rat(c)
	}
	return p
}

// Random integer assignment: symbolic identities must hold under evaluation.
func TestEvalIdentities(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	s := NewSym(0)
	for trial := 0; trial < 200; trial++ {
		a := randomPoly(r, 4, 3, 5)
		b := randomPoly(r, 4, 3, 5)
		var xs [MaxVars]int64
		for i := range xs {
			xs[i] = r.Int63n(11) - 5
		}
		ea, eb := a.EvalInt(xs), b.EvalInt(xs)

		if got, want := s.Add(a, b).EvalInt(xs), new(big.Rat).Add(ea, eb); got.Cmp(want) != 0 {
			t.Fatalf("add: got %v, want %v", got, want)
		}
		if got, want := s.Sub(a, b).EvalInt(xs), new(big.Rat).Sub(ea, eb); got.Cmp(want) != 0 {
			t.Fatalf("sub: got %v, want %v", got, want)
		}
		if got, want := s.Mul(a, b).EvalInt(xs), new(big.Rat).Mul(ea, eb); got.Cmp(want) != 0 {
			t.Fatalf("mul: got %v, want %v", got, want)
		}
		n := uint64(r.Intn(4))
		want := rat(1)
		for i := uint64(0); i < n; i++ {
			want.Mul(want, ea)
		}
		if got := s.Pow(a, n).EvalInt(xs); got.Cmp(want) != 0 {
			t.Fatalf("pow(%d): got %v, want %v", n, got, want)
		}
	}
}

// Small expansion reference: (1 + x0 - x1)^3 expanded by brute-force
// enumeration of all 3^3 summand choices, independent of the library's Mul.
func TestPowReferenceExpansion(t *testing.T) {
	s := NewSym(0)
	p := s.Add(s.Add(ConstInt(1), Var(0)), s.Neg(Var(1)))
	got := s.Pow(p, 3)

	type summand struct {
		m Mono
		c int64
	}
	summands := []summand{{Mono{}, 1}, {Mono{1}, 1}, {Mono{0, 1}, -1}}
	ref := make(map[Mono]*big.Rat)
	for _, a := range summands {
		for _, b := range summands {
			for _, c := range summands {
				var m Mono
				for i := range m {
					m[i] = a.m[i] + b.m[i] + c.m[i]
				}
				v := rat(a.c * b.c * c.c)
				if e, ok := ref[m]; ok {
					e.Add(e, v)
				} else {
					ref[m] = v
				}
			}
		}
	}
	for m, v := range ref {
		if v.Sign() == 0 {
			delete(ref, m)
		}
	}
	if got.NumTerms() != len(ref) {
		t.Fatalf("term count: got %d, want %d (%s)", got.NumTerms(), len(ref), got)
	}
	for m, want := range ref {
		c, ok := got.terms[m]
		if !ok || c.Cmp(want) != 0 {
			t.Fatalf("coeff of %v: got %v, want %v", m, c, want)
		}
	}
}

func TestEqual(t *testing.T) {
	s := NewSym(0)
	x, y := Var(0), Var(1)
	lhs := s.Pow(s.Add(x, y), 2)
	rhs := s.Add(s.Add(s.Pow(x, 2), s.Mul(ConstInt(2), s.Mul(x, y))), s.Pow(y, 2))

	eq, decidable := s.Equal(lhs, rhs)
	if !decidable || !eq {
		t.Fatalf("(x+y)^2 must equal x^2+2xy+y^2 (eq=%v, decidable=%v)", eq, decidable)
	}

	eq, decidable = s.Equal(lhs, s.Pow(x, 2))
	if !decidable || eq {
		t.Fatalf("(x+y)^2 vs x^2 must be a decidable inequality (eq=%v, decidable=%v)", eq, decidable)
	}
}

// Budget exhausted: the truncated result cannot decide (in)equality.
func TestBudgetExhausted(t *testing.T) {
	s := NewSym(2) // (x+y)^2 expands to 3 terms, exceeding the budget
	x, y := Var(0), Var(1)

	a := s.Pow(s.Add(x, y), 2)
	if !a.Uncertain() {
		t.Fatal("expected truncated result to be marked uncertain")
	}
	if a.NumTerms() != 2 {
		t.Fatalf("expected truncation to 2 terms, got %d", a.NumTerms())
	}

	exact := NewSym(0)
	b := exact.Add(exact.Add(exact.Pow(x, 2), exact.Mul(ConstInt(2), exact.Mul(x, y))), exact.Pow(y, 2))

	eq, decidable := s.Equal(a, b)
	if decidable {
		t.Fatalf("budget exhausted: must be undecidable (eq=%v)", eq)
	}
}

func TestMonomialOrderAndCoefficients(t *testing.T) {
	s := NewSym(0)
	// Build 1 + 3*x0 + 2*x1^2 out of order.
	p := s.Add(s.Add(s.Mul(ConstInt(2), s.Pow(Var(1), 2)), s.Mul(ConstInt(3), Var(0))), ConstInt(1))

	ts := p.Terms()
	wantDeg := []int{0, 1, 2}
	if len(ts) != len(wantDeg) {
		t.Fatalf("got %d terms, want %d", len(ts), len(wantDeg))
	}
	for i, tm := range ts {
		if tm.Mono.Degree() != wantDeg[i] {
			t.Fatalf("term %d: degree %d, want %d", i, tm.Mono.Degree(), wantDeg[i])
		}
	}

	cs := p.Coefficients()
	want := []string{"1", "3", "2"}
	for i := range want {
		if cs[i].RatString() != want[i] {
			t.Fatalf("coefficient %d: got %s, want %s", i, cs[i].RatString(), want[i])
		}
	}

	if got := p.String(); got != "1 + 3*x0 + 2*x1^2" {
		t.Fatalf("String: got %q", got)
	}
}

func TestNormalize(t *testing.T) {
	s := NewSym(0)
	x := Var(0)

	z := s.Sub(x, x)
	if z.NumTerms() != 0 || z.String() != "0" {
		t.Fatalf("x - x must normalize to zero, got %s", z)
	}

	w := s.Sub(s.Mul(ConstInt(2), x), x)
	if eq, decidable := s.Equal(w, x); !decidable || !eq {
		t.Fatal("2x - x must equal x")
	}
}

func TestRationalCoefficients(t *testing.T) {
	s := NewSym(0)
	half := Const(big.NewRat(1, 2))
	third := Const(big.NewRat(1, 3))
	p := s.Add(s.Mul(half, Var(0)), s.Mul(third, Var(0)))

	cs := p.Coefficients()
	if len(cs) != 1 || cs[0].Cmp(big.NewRat(5, 6)) != 0 {
		t.Fatalf("1/2 x + 1/3 x: got coefficients %v", cs)
	}
}
