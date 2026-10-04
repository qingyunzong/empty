package statmatch

import (
	"math/big"
	"testing"
)

func mkPairs(xs, ys []int64) []Pair {
	pairs := make([]Pair, len(xs))
	for i := range xs {
		pairs[i] = Pair{
			A:    Point{ID: "a" + string(rune('0'+i)), T: rat(int64(i), 1), V: xs[i]},
			B:    Point{ID: "b" + string(rune('0'+i)), T: rat(int64(i), 1), V: ys[i]},
			Diff: rat(0, 1),
		}
	}
	return pairs
}

func wantBig(t *testing.T, name string, got *big.Int, want int64) {
	t.Helper()
	if got.Cmp(big.NewInt(want)) != 0 {
		t.Fatalf("%s = %s, want %d", name, got, want)
	}
}

// x = 1,2,3 and y = 1,2,4 give Cov = 9, VarX = 6, VarY = 14, so
// r = 9/√84 = 3√21/14.
func TestStatsExactIntegers(t *testing.T) {
	st := DirectSums(mkPairs([]int64{1, 2, 3}, []int64{1, 2, 4})).Stats()
	if !st.Defined {
		t.Fatal("stats should be defined")
	}
	wantBig(t, "Cov", st.Cov, 9)
	wantBig(t, "VarX", st.VarX, 6)
	wantBig(t, "VarY", st.VarY, 14)
	wantBig(t, "R.Num", st.R.Num, 3)
	wantBig(t, "R.Den", st.R.Den, 14)
	wantBig(t, "R.Sqr", st.R.Sqr, 21)
	if got := st.R.String(); got != "3√21/14" {
		t.Fatalf("R = %s, want 3√21/14", got)
	}
}

// x = 1,2,3 and y = 1,2,6 give Cov = 15, VarX = 6, VarY = 42, so
// r = 15/√252 = 5√7/14.
func TestCorrelationRadicalExtraction(t *testing.T) {
	st := DirectSums(mkPairs([]int64{1, 2, 3}, []int64{1, 2, 6})).Stats()
	wantBig(t, "Cov", st.Cov, 15)
	wantBig(t, "VarX", st.VarX, 6)
	wantBig(t, "VarY", st.VarY, 42)
	wantBig(t, "R.Num", st.R.Num, 5)
	wantBig(t, "R.Den", st.R.Den, 14)
	wantBig(t, "R.Sqr", st.R.Sqr, 7)
	if got := st.R.String(); got != "5√7/14" {
		t.Fatalf("R = %s, want 5√7/14", got)
	}
}

func TestCorrelationPerfectAndNegative(t *testing.T) {
	st := DirectSums(mkPairs([]int64{1, 2, 3, 4}, []int64{2, 4, 6, 8})).Stats()
	if got := st.R.String(); got != "1" {
		t.Fatalf("R = %s, want 1", got)
	}
	st = DirectSums(mkPairs([]int64{1, 2, 3, 4}, []int64{-2, -4, -6, -8})).Stats()
	if got := st.R.String(); got != "-1" {
		t.Fatalf("R = %s, want -1", got)
	}
}

func TestStatsUndefined(t *testing.T) {
	cases := map[string][]Pair{
		"no pairs":      mkPairs(nil, nil),
		"one pair":      mkPairs([]int64{1}, []int64{2}),
		"zero var x":    mkPairs([]int64{1, 1, 1}, []int64{1, 2, 3}),
		"zero var y":    mkPairs([]int64{1, 2, 3}, []int64{7, 7, 7}),
		"zero var both": mkPairs([]int64{2, 2}, []int64{5, 5}),
	}
	for name, pairs := range cases {
		st := DirectSums(pairs).Stats()
		if st.Defined {
			t.Fatalf("%s: stats should be undefined", name)
		}
	}
}

// Large values must stay exact through big.Int arithmetic.
func TestStatsLargeValues(t *testing.T) {
	xs := []int64{1 << 40, -(1 << 41), 1 << 42, -(1 << 43), 1 << 44}
	ys := []int64{-(1 << 39), 1 << 40, -(1 << 41), 1 << 42, -(1 << 43)}
	st := DirectSums(mkPairs(xs, ys)).Stats()
	if !st.Defined {
		t.Fatal("stats should be defined")
	}
	// Recompute Cov independently with big.Int from the raw values.
	n := big.NewInt(int64(len(xs)))
	sx, sy, sxy := new(big.Int), new(big.Int), new(big.Int)
	for i := range xs {
		bx, by := big.NewInt(xs[i]), big.NewInt(ys[i])
		sx.Add(sx, bx)
		sy.Add(sy, by)
		sxy.Add(sxy, new(big.Int).Mul(bx, by))
	}
	cov := new(big.Int).Sub(new(big.Int).Mul(n, sxy), new(big.Int).Mul(sx, sy))
	if st.Cov.Cmp(cov) != 0 {
		t.Fatalf("Cov = %s, want %s", st.Cov, cov)
	}
}
