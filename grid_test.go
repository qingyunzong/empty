package interval

import (
	"math/big"
	"strings"
	"testing"
)

func TestEnumerateBasic(t *testing.T) {
	// f(x, y) = x*y + x over x in {0, 1/2, 1}, y in {-1, 2}
	e := Add{Mul{Var{0}, Var{1}}, Var{0}}
	cert, err := Enumerate(e, [][]*big.Rat{
		{Rat(0, 1), Rat(1, 2), Rat(1, 1)},
		{Rat(-1, 1), Rat(2, 1)},
	})
	if err != nil {
		t.Fatal(err)
	}
	// f = x*(y+1): y=-1 gives 0 for all x; y=2 gives 0, 3/2, 3
	if cert.Total() != 6 || cert.Defined != 6 || cert.Undefined != 0 {
		t.Fatalf("counts: %v", cert)
	}
	if cert.Min.Sign() != 0 || cert.Max.Cmp(Rat(3, 1)) != 0 {
		t.Fatalf("extrema: %v", cert)
	}
	if cert.MinAt[0].Sign() != 0 || cert.MinAt[1].Cmp(Rat(-1, 1)) != 0 {
		t.Fatalf("min witness: %v", cert)
	}
	if cert.MaxAt[0].Cmp(Rat(1, 1)) != 0 || cert.MaxAt[1].Cmp(Rat(2, 1)) != 0 {
		t.Fatalf("max witness: %v", cert)
	}
}

func TestEnumerateBranch(t *testing.T) {
	// f(x) = if x <= 1/2 then x else 1 - x, grid {0, 1/4, 1/2, 3/4, 1}
	e := If{Cond{LE, Var{0}, Const{Rat(1, 2)}},
		Var{0}, Sub{Const{Rat(1, 1)}, Var{0}}}
	cert, err := Enumerate(e, [][]*big.Rat{
		{Rat(0, 1), Rat(1, 4), Rat(1, 2), Rat(3, 4), Rat(1, 1)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if cert.Min.Sign() != 0 || cert.Max.Cmp(Rat(1, 2)) != 0 {
		t.Fatalf("extrema: %v", cert)
	}
}

func TestEnumerateUndefinedCounted(t *testing.T) {
	// f(x) = 1/x over {-1, 0, 1}: undefined at 0
	e := Div{Const{Rat(1, 1)}, Var{0}}
	cert, err := Enumerate(e, [][]*big.Rat{{Rat(-1, 1), Rat(0, 1), Rat(1, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	if cert.Defined != 2 || cert.Undefined != 1 {
		t.Fatalf("counts: %v", cert)
	}
	if cert.Min.Cmp(Rat(-1, 1)) != 0 || cert.Max.Cmp(Rat(1, 1)) != 0 {
		t.Fatalf("extrema: %v", cert)
	}
}

func TestEnumerateMaxVars(t *testing.T) {
	grids := make([][]*big.Rat, MaxVars+1)
	for i := range grids {
		grids[i] = []*big.Rat{Rat(0, 1)}
	}
	if _, err := Enumerate(Const{Rat(0, 1)}, grids); err == nil {
		t.Fatal("expected error for more than 6 variables")
	}
	// exactly 6 variables works
	cert, err := Enumerate(Const{Rat(1, 1)}, grids[:MaxVars])
	if err != nil || cert.Defined != 1 {
		t.Fatalf("6 vars: cert=%v err=%v", cert, err)
	}
}

func TestEnumerateMissingGrid(t *testing.T) {
	if _, err := Enumerate(Var{1}, [][]*big.Rat{{Rat(0, 1)}}); err == nil {
		t.Fatal("expected error when expression uses more variables than grids")
	}
	if _, err := Enumerate(Const{Rat(0, 1)}, [][]*big.Rat{{}}); err == nil {
		t.Fatal("expected error for empty grid")
	}
}

func TestCertificateCheck(t *testing.T) {
	e := Add{Mul{Var{0}, Var{1}}, Var{0}}
	grids := [][]*big.Rat{
		{Rat(0, 1), Rat(1, 2), Rat(1, 1)},
		{Rat(-1, 1), Rat(2, 1)},
	}
	cert, err := Enumerate(e, grids)
	if err != nil {
		t.Fatal(err)
	}
	if err := cert.Check(e, grids); err != nil {
		t.Fatalf("valid certificate rejected: %v", err)
	}

	bad := cert
	bad.Max = Rat(7, 1)
	if err := bad.Check(e, grids); err == nil || !strings.Contains(err.Error(), "max") {
		t.Fatalf("tampered max accepted: %v", err)
	}

	bad = cert
	bad.Undefined = 3
	if err := bad.Check(e, grids); err == nil || !strings.Contains(err.Error(), "count") {
		t.Fatalf("tampered count accepted: %v", err)
	}

	bad = cert
	bad.MinAt = []*big.Rat{Rat(9, 1), Rat(9, 1)}
	if err := bad.Check(e, grids); err == nil || !strings.Contains(err.Error(), "witness") {
		t.Fatalf("tampered witness accepted: %v", err)
	}
}

func TestVerifyBounds(t *testing.T) {
	e := Add{Var{0}, Var{1}}
	grids := [][]*big.Rat{{Rat(0, 1), Rat(1, 1)}, {Rat(0, 1), Rat(1, 1)}}
	if err := VerifyBounds(e, grids, Rat(0, 1), Rat(2, 1)); err != nil {
		t.Fatalf("valid bound rejected: %v", err)
	}
	if err := VerifyBounds(e, grids, Rat(0, 1), Rat(1, 1)); err == nil {
		t.Fatal("too-tight upper bound accepted")
	}
	if err := VerifyBounds(e, grids, Rat(1, 2), Rat(2, 1)); err == nil {
		t.Fatal("too-tight lower bound accepted")
	}
}

func TestCertificateWitnessReevaluates(t *testing.T) {
	// Re-evaluating at the certificate witnesses must reproduce the
	// reported extrema.
	e := Sub{Mul{Var{0}, Var{0}}, Mul{Var{1}, Var{1}}}
	grids := [][]*big.Rat{
		{Rat(-2, 1), Rat(-1, 2), Rat(1, 1)},
		{Rat(0, 1), Rat(3, 2)},
	}
	cert, err := Enumerate(e, grids)
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := Eval(e, cert.MinAt); !ok || got.Cmp(cert.Min) != 0 {
		t.Fatalf("min witness re-evaluates to %v, want %v", got, cert.Min)
	}
	if got, ok := Eval(e, cert.MaxAt); !ok || got.Cmp(cert.Max) != 0 {
		t.Fatalf("max witness re-evaluates to %v, want %v", got, cert.Max)
	}
}
