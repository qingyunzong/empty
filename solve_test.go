package markov

import (
	"math/big"
	"testing"
)

func rat(t *testing.T, s string) *big.Rat {
	t.Helper()
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		t.Fatalf("bad rational %q", s)
	}
	return r
}

func ratsEq(t *testing.T, got []*big.Rat, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d values, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i].Cmp(rat(t, w)) != 0 {
			t.Errorf("x[%d] = %s, want %s", i, got[i].RatString(), w)
		}
	}
}

func TestSolveRationalKnown(t *testing.T) {
	// 2x + y = 1, x + 3y = 2  =>  x = 1/5, y = 3/5
	a := [][]*big.Rat{
		{big.NewRat(2, 1), big.NewRat(1, 1)},
		{big.NewRat(1, 1), big.NewRat(3, 1)},
	}
	b := []*big.Rat{big.NewRat(1, 1), big.NewRat(2, 1)}
	x, err := SolveRational(a, b)
	if err != nil {
		t.Fatal(err)
	}
	ratsEq(t, x, "1/5", "3/5")
}

func TestSolveRationalFractional(t *testing.T) {
	// (1/2)x - (1/3)y = 1/6, (1/4)x + y = 5/4  =>  x = 1, y = 1
	a := [][]*big.Rat{
		{big.NewRat(1, 2), big.NewRat(-1, 3)},
		{big.NewRat(1, 4), big.NewRat(1, 1)},
	}
	b := []*big.Rat{big.NewRat(1, 6), big.NewRat(5, 4)}
	x, err := SolveRational(a, b)
	if err != nil {
		t.Fatal(err)
	}
	ratsEq(t, x, "1", "1")
}

func TestSolveBareissKnown(t *testing.T) {
	a := [][]*big.Int{
		{big.NewInt(2), big.NewInt(1)},
		{big.NewInt(1), big.NewInt(3)},
	}
	b := []*big.Int{big.NewInt(1), big.NewInt(2)}
	x, err := SolveBareiss(a, b)
	if err != nil {
		t.Fatal(err)
	}
	ratsEq(t, x, "1/5", "3/5")
}

func TestSolversSingular(t *testing.T) {
	ar := [][]*big.Rat{
		{big.NewRat(1, 1), big.NewRat(2, 1)},
		{big.NewRat(2, 1), big.NewRat(4, 1)},
	}
	br := []*big.Rat{big.NewRat(1, 1), big.NewRat(2, 1)}
	if _, err := SolveRational(ar, br); err == nil {
		t.Error("SolveRational: expected singular error")
	}
	ai := [][]*big.Int{
		{big.NewInt(1), big.NewInt(2)},
		{big.NewInt(2), big.NewInt(4)},
	}
	bi := []*big.Int{big.NewInt(1), big.NewInt(2)}
	if _, err := SolveBareiss(ai, bi); err == nil {
		t.Error("SolveBareiss: expected singular error")
	}
}

// TestBareissMatchesRational is the independent fraction-elimination
// cross-check: deterministic pseudo-random diagonally dominant integer
// systems are solved by both the big.Rat Gaussian elimination and the
// fraction-free Bareiss elimination, and the exact solutions must agree.
func TestBareissMatchesRational(t *testing.T) {
	seed := int64(20261005)
	next := func(mod int64) int64 {
		seed = (seed*6364136223846793005 + 1442695040888963407) >> 16
		v := seed % mod
		if v < 0 {
			v += mod
		}
		return v
	}
	for n := 1; n <= 6; n++ {
		for trial := 0; trial < 8; trial++ {
			ai := make([][]*big.Int, n)
			bi := make([]*big.Int, n)
			ar := make([][]*big.Rat, n)
			br := make([]*big.Rat, n)
			for i := 0; i < n; i++ {
				ai[i] = make([]*big.Int, n)
				ar[i] = make([]*big.Rat, n)
				diag := int64(1)
				for j := 0; j < n; j++ {
					if j != i {
						v := next(7) - 3 // in [-3, 3]
						ai[i][j] = big.NewInt(v)
						if v < 0 {
							diag -= v
						} else {
							diag += v
						}
					}
				}
				ai[i][i] = big.NewInt(diag) // strictly diagonally dominant
				bi[i] = big.NewInt(next(11) - 5)
				for j := 0; j < n; j++ {
					ar[i][j] = new(big.Rat).SetInt(ai[i][j])
				}
				br[i] = new(big.Rat).SetInt(bi[i])
			}
			xr, err := SolveRational(ar, br)
			if err != nil {
				t.Fatalf("n=%d trial=%d: SolveRational: %v", n, trial, err)
			}
			xb, err := SolveBareiss(ai, bi)
			if err != nil {
				t.Fatalf("n=%d trial=%d: SolveBareiss: %v", n, trial, err)
			}
			for i := range xr {
				if xr[i].Cmp(xb[i]) != 0 {
					t.Errorf("n=%d trial=%d x[%d]: rational=%s bareiss=%s",
						n, trial, i, xr[i].RatString(), xb[i].RatString())
				}
			}
		}
	}
}
