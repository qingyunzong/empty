package statcorr

import (
	"math/big"
	"math/rand"
	"testing"
)

func bi(v int64) *big.Int { return big.NewInt(v) }

func dataset(pts ...[2]int64) [][2]*big.Int {
	out := make([][2]*big.Int, len(pts))
	for i, p := range pts {
		out[i] = [2]*big.Int{bi(p[0]), bi(p[1])}
	}
	return out
}

func TestIncrementalAddRemoveVsDirect(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	st := NewStats()
	var pts [][2]*big.Int
	for step := 0; step < 500; step++ {
		if len(pts) == 0 || r.Intn(2) == 0 {
			p := [2]*big.Int{bi(int64(r.Intn(200) - 100)), bi(int64(r.Intn(200) - 100))}
			pts = append(pts, p)
			st.Add(p[0], p[1])
		} else {
			i := r.Intn(len(pts))
			st.Remove(pts[i][0], pts[i][1])
			pts = append(pts[:i], pts[i+1:]...)
		}
		if got, want := st.Certificate(), Direct(pts).Certificate(); got != want {
			t.Fatalf("step %d: incremental %q != direct %q", step, got, want)
		}
	}
}

func TestExactIntegerMoments(t *testing.T) {
	st := Direct(dataset([2]int64{1, 2}, [2]int64{2, 4}, [2]int64{3, 5}, [2]int64{4, 4}, [2]int64{5, 7}))
	if st.CovNum().String() != "50" {
		t.Fatalf("covnum = %s, want 50", st.CovNum())
	}
	if st.VarXNum().String() != "50" {
		t.Fatalf("varxnum = %s, want 50", st.VarXNum())
	}
	if st.VarYNum().String() != "66" {
		t.Fatalf("varynum = %s, want 66", st.VarYNum())
	}
	if got := st.Correlation().String(); got != "5*sqrt(33)/33" {
		t.Fatalf("r = %s, want 5*sqrt(33)/33", got)
	}
}

func TestCorrelationValues(t *testing.T) {
	cases := []struct {
		name string
		pts  [][2]*big.Int
		want string
	}{
		{"perfect positive", dataset([2]int64{0, 0}, [2]int64{1, 1}, [2]int64{2, 2}), "1"},
		{"perfect negative", dataset([2]int64{0, 1}, [2]int64{1, 0}), "-1"},
		{"zero", dataset([2]int64{0, 0}, [2]int64{1, 1}, [2]int64{2, 0}), "0"},
		{"rational", dataset([2]int64{0, 0}, [2]int64{1, 0}, [2]int64{0, 1}), "-1/2"},
		{"radical", dataset([2]int64{0, 0}, [2]int64{1, 1}, [2]int64{2, 1}), "sqrt(3)/2"},
		{"large integers", dataset([2]int64{1000000007, 3}, [2]int64{-1000000007, 1}), "1"},
	}
	for _, c := range cases {
		if got := Direct(c.pts).Correlation().String(); got != c.want {
			t.Errorf("%s: r = %s, want %s", c.name, got, c.want)
		}
	}
}

func TestCorrelationUndefined(t *testing.T) {
	cases := []struct {
		name string
		pts  [][2]*big.Int
		want string
	}{
		{"empty", nil, "undefined(fewer than two aligned points)"},
		{"single point", dataset([2]int64{1, 2}), "undefined(fewer than two aligned points)"},
		{"zero x variance", dataset([2]int64{3, 1}, [2]int64{3, 2}, [2]int64{3, 3}), "undefined(zero variance)"},
		{"zero y variance", dataset([2]int64{1, 7}, [2]int64{2, 7}), "undefined(zero variance)"},
	}
	for _, c := range cases {
		if got := Direct(c.pts).Correlation().String(); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

func TestCorrelationUndefinedAfterRemoval(t *testing.T) {
	st := Direct(dataset([2]int64{0, 0}, [2]int64{1, 1}))
	if got := st.Correlation().String(); got != "1" {
		t.Fatalf("r = %s, want 1", got)
	}
	st.Remove(bi(1), bi(1))
	if got := st.Correlation().String(); got != "undefined(fewer than two aligned points)" {
		t.Fatalf("after removal r = %s, want undefined", got)
	}
}
