package markov

import (
	"math/big"
	"testing"
)

func parseRow(t *testing.T, entries ...string) []*big.Rat {
	t.Helper()
	row := make([]*big.Rat, len(entries))
	for i, s := range entries {
		v, ok := new(big.Rat).SetString(s)
		if !ok {
			t.Fatalf("bad rational %q", s)
		}
		row[i] = v
	}
	return row
}

func TestSolveGaussKnown(t *testing.T) {
	// 2x + y = 5, x - 3y = -1  =>  x = 2, y = 1
	a := [][]*big.Rat{parseRow(t, "2", "1"), parseRow(t, "1", "-3")}
	b := parseRow(t, "5", "-1")
	x, err := SolveGauss(a, b)
	if err != nil {
		t.Fatalf("SolveGauss: %v", err)
	}
	ratEq(t, x[0], "2")
	ratEq(t, x[1], "1")
}

// TestBareissMatchesGauss runs both independent eliminations on a system
// with mixed denominators and requires exact agreement plus zero residual.
func TestBareissMatchesGauss(t *testing.T) {
	a := [][]*big.Rat{
		parseRow(t, "1/2", "1/3", "1/5"),
		parseRow(t, "1/3", "1/4", "1/6"),
		parseRow(t, "1/5", "1/6", "1/7"),
	}
	b := parseRow(t, "1", "-1", "2")
	xg, err := SolveGauss(a, b)
	if err != nil {
		t.Fatalf("SolveGauss: %v", err)
	}
	xb, err := SolveBareiss(a, b)
	if err != nil {
		t.Fatalf("SolveBareiss: %v", err)
	}
	for i := range xg {
		if xg[i].Cmp(xb[i]) != 0 {
			t.Errorf("x[%d]: Gauss %s != Bareiss %s", i, xg[i], xb[i])
		}
		res := new(big.Rat)
		for j := range a[i] {
			res.Add(res, new(big.Rat).Mul(a[i][j], xg[j]))
		}
		res.Sub(res, b[i])
		if res.Sign() != 0 {
			t.Errorf("row %d residual %s, want 0", i, res)
		}
	}
}

func TestSolversDetectSingular(t *testing.T) {
	a := [][]*big.Rat{parseRow(t, "1", "2"), parseRow(t, "2", "4")}
	b := parseRow(t, "1", "2")
	if _, err := SolveGauss(a, b); err == nil {
		t.Error("SolveGauss: expected singular error")
	}
	if _, err := SolveBareiss(a, b); err == nil {
		t.Error("SolveBareiss: expected singular error")
	}
}
