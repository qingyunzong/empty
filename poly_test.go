package poly

import (
	"errors"
	"math/big"
	"math/rand"
	"testing"
)

func mono(e ...int) Mono {
	var m Mono
	copy(m[:], e)
	return m
}

// binom computes n choose k independently via Pascal's rule.
func binom(n, k int64) *big.Rat {
	if k < 0 || k > n {
		return new(big.Rat)
	}
	c := big.NewRat(1, 1)
	for i := int64(1); i <= k; i++ {
		c.Mul(c, big.NewRat(n-i+1, i))
	}
	return c
}

// TestPowBinomialExpansion verifies (x+y)^n against the binomial theorem
// for small n (small-expansion reference check).
func TestPowBinomialExpansion(t *testing.T) {
	x, y := Var(0), Var(1)
	for n := uint(0); n <= 8; n++ {
		sum, err := Add(x, y, 2)
		if err != nil {
			t.Fatal(err)
		}
		p, err := Pow(sum, n, 64)
		if err != nil {
			t.Fatalf("n=%d: %v", n, err)
		}
		if got, want := p.NumTerms(), int(n)+1; got != want {
			t.Fatalf("n=%d: got %d terms, want %d", n, got, want)
		}
		for k := int64(0); k <= int64(n); k++ {
			exp := mono(int(int64(n)-k), int(k))
			if got := p.Coeff(exp); got.Cmp(binom(int64(n), k)) != 0 {
				t.Errorf("n=%d k=%d: coeff = %s, want %s", n, k, got, binom(int64(n), k))
			}
		}
	}
}

// TestSquareOfSumFiveVars checks (x+y+z+u+v)^2 against the multinomial
// expansion: every variable squared has coefficient 1, every cross term 2.
func TestSquareOfSumFiveVars(t *testing.T) {
	sum := Zero()
	var err error
	for i := 0; i < MaxVars; i++ {
		sum, err = Add(sum, Var(i), MaxVars)
		if err != nil {
			t.Fatal(err)
		}
	}
	p, err := Mul(sum, sum, 64)
	if err != nil {
		t.Fatal(err)
	}
	want := 2*MaxVars + MaxVars*(MaxVars-1)/2 - MaxVars // squares + cross terms
	if got := p.NumTerms(); got != want {
		t.Fatalf("got %d terms, want %d", got, want)
	}
	for i := 0; i < MaxVars; i++ {
		exp := mono()
		exp[i] = 2
		if c := p.Coeff(exp); c.Cmp(big.NewRat(1, 1)) != 0 {
			t.Errorf("x%d^2 coeff = %s, want 1", i, c)
		}
		for j := i + 1; j < MaxVars; j++ {
			exp := mono()
			exp[i], exp[j] = 1, 1
			if c := p.Coeff(exp); c.Cmp(big.NewRat(2, 1)) != 0 {
				t.Errorf("x%d*x%d coeff = %s, want 2", i, j, c)
			}
		}
	}
}

// TestDifferenceOfSquares verifies (x+y)(x-y) == x^2 - y^2 via normalized
// equality.
func TestDifferenceOfSquares(t *testing.T) {
	x, y := Var(0), Var(1)
	sum, _ := Add(x, y, 4)
	diff, _ := Sub(x, y, 4)
	lhs, err := Mul(sum, diff, 8)
	if err != nil {
		t.Fatal(err)
	}
	x2, _ := Pow(x, 2, 4)
	y2, _ := Pow(y, 2, 4)
	rhs, err := Sub(x2, y2, 4)
	if err != nil {
		t.Fatal(err)
	}
	if eq, known := Equal(lhs, rhs, 8); !known || !eq {
		t.Fatalf("(x+y)(x-y) != x^2-y^2 (eq=%v known=%v)", eq, known)
	}
}

// TestRationalCoefficients checks (1/2 x + 1/3 y)^2 = 1/4 x^2 + 1/3 xy + 1/9 y^2.
func TestRationalCoefficients(t *testing.T) {
	half := Monomial(big.NewRat(1, 2), mono(1))
	third := Monomial(big.NewRat(1, 3), mono(0, 1))
	sum, err := Add(half, third, 4)
	if err != nil {
		t.Fatal(err)
	}
	p, err := Pow(sum, 2, 8)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		exp  Mono
		want *big.Rat
	}{
		{mono(2, 0), big.NewRat(1, 4)},
		{mono(1, 1), big.NewRat(1, 3)},
		{mono(0, 2), big.NewRat(1, 9)},
	}
	for _, tc := range cases {
		if got := p.Coeff(tc.exp); got.Cmp(tc.want) != 0 {
			t.Errorf("coeff of %v = %s, want %s", tc.exp, got, tc.want)
		}
	}
}

// randPoly builds a random polynomial with rational coefficients.
func randPoly(rng *rand.Rand, maxTerms, maxDeg int) *Poly {
	p := Zero()
	n := 1 + rng.Intn(maxTerms)
	for i := 0; i < n; i++ {
		var m Mono
		for j := range m {
			m[j] = rng.Intn(maxDeg + 1)
		}
		num := int64(rng.Intn(11) - 5)
		den := int64(1 + rng.Intn(4))
		c := big.NewRat(num, den)
		if old, ok := p.terms[m]; ok {
			c.Add(c, old)
		}
		if c.Sign() != 0 {
			p.terms[m] = c
		} else {
			delete(p.terms, m)
		}
	}
	return p
}

// TestRandomIntegerEvaluation verifies identities by random integer
// assignment: (p+q)(p-q) evaluated at random points must equal p^2-q^2
// evaluated there, and p^n likewise.
func TestRandomIntegerEvaluation(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 200; trial++ {
		p := randPoly(rng, 4, 3)
		q := randPoly(rng, 4, 3)
		sum, err := Add(p, q, 64)
		if err != nil {
			t.Fatal(err)
		}
		diff, err := Sub(p, q, 64)
		if err != nil {
			t.Fatal(err)
		}
		lhs, err := Mul(sum, diff, 256)
		if err != nil {
			t.Fatal(err)
		}
		p2, _ := Pow(p, 2, 256)
		q2, _ := Pow(q, 2, 256)
		rhs, err := Sub(p2, q2, 256)
		if err != nil {
			t.Fatal(err)
		}
		if eq, known := Equal(lhs, rhs, 512); !known || !eq {
			t.Fatalf("trial %d: (p+q)(p-q) != p^2-q^2", trial)
		}

		var pt [MaxVars]*big.Int
		for i := range pt {
			pt[i] = big.NewInt(int64(rng.Intn(9) - 4))
		}
		lv, rv := lhs.Eval(pt), rhs.Eval(pt)
		if lv.Cmp(rv) != 0 {
			t.Fatalf("trial %d: eval mismatch %s != %s at %v", trial, lv, rv, pt)
		}

		n := uint(rng.Intn(4))
		pn, err := Pow(p, n, 512)
		if err != nil {
			t.Fatal(err)
		}
		want := new(big.Rat).SetInt64(1)
		pv := p.Eval(pt)
		for i := uint(0); i < n; i++ {
			want.Mul(want, pv)
		}
		if got := pn.Eval(pt); got.Cmp(want) != 0 {
			t.Fatalf("trial %d: p^%d eval = %s, want %s", trial, n, got, want)
		}
	}
}

// TestBudgetExhaustion checks that operations fail loudly when the term
// budget runs out, and that equality then reports "unknown" rather than
// "not equal".
func TestBudgetExhaustion(t *testing.T) {
	x, y := Var(0), Var(1)
	sum, _ := Add(x, y, 2)

	// (x+y)^10 has 11 terms: budget 5 must fail, budget 11 must succeed.
	if _, err := Pow(sum, 10, 5); !errors.Is(err, ErrBudgetExhausted) {
		t.Fatalf("expected ErrBudgetExhausted, got %v", err)
	}
	if _, err := Pow(sum, 10, 11); err != nil {
		t.Fatalf("budget 11 should suffice: %v", err)
	}

	// Mul budget: (x+y)*(x+y+z) has 5 distinct monomials.
	z := Var(2)
	s3, _ := Add(sum, z, 3)
	if _, err := Mul(sum, s3, 4); !errors.Is(err, ErrBudgetExhausted) {
		t.Fatalf("expected ErrBudgetExhausted, got %v", err)
	}
	if got, err := Mul(sum, s3, 5); err != nil || got.NumTerms() != 5 {
		t.Fatalf("budget 5 should suffice: terms=%d err=%v", got.NumTerms(), err)
	}

	// Equal with a too-small budget: difference needs 2 terms, budget 1.
	if eq, known := Equal(x, y, 1); known || eq {
		t.Fatalf("budget 1: got eq=%v known=%v, want undecided", eq, known)
	}
	if eq, known := Equal(x, y, 2); !known || eq {
		t.Fatalf("budget 2: got eq=%v known=%v, want known unequal", eq, known)
	}
	if eq, known := Equal(x, x, 1); !known || !eq {
		t.Fatalf("x == x must be decided even with budget 1, got eq=%v known=%v", eq, known)
	}
}

// TestStringOrder checks monomial ordering and formatting of the output.
func TestStringOrder(t *testing.T) {
	// 2*x^2 + 3/4*x*y - y^2 + 5, built out of order.
	p := Zero()
	p.terms[mono(0, 2)] = big.NewRat(-1, 1)
	p.terms[mono(0, 0)] = big.NewRat(5, 1)
	p.terms[mono(1, 1)] = big.NewRat(3, 4)
	p.terms[mono(2, 0)] = big.NewRat(2, 1)
	want := "2*x^2 + 3/4*x*y - y^2 + 5"
	if got := p.String(); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if got := Zero().String(); got != "0" {
		t.Fatalf("zero poly: got %q", got)
	}
	q, _ := Add(Var(2), ConstInt(-3), 4)
	if got := q.String(); got != "z - 3" {
		t.Fatalf("got %q, want %q", got, "z - 3")
	}
}
