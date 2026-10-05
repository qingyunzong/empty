package interval

import (
	"math/big"
	"testing"
)

func env(rs ...*big.Rat) []*big.Rat { return rs }

func TestEvalExact(t *testing.T) {
	// (x + 1/2) * y at x=1/2, y=2/3 -> 2/3
	e := Mul{Add{Var{0}, Const{Rat(1, 2)}}, Var{1}}
	got, ok := Eval(e, env(Rat(1, 2), Rat(2, 3)))
	if !ok || got.Cmp(Rat(2, 3)) != 0 {
		t.Fatalf("eval: got %v ok=%v", got, ok)
	}
}

func TestEvalDivByZeroPoint(t *testing.T) {
	e := Div{Const{Rat(1, 1)}, Var{0}}
	if _, ok := Eval(e, env(Rat(0, 1))); ok {
		t.Fatal("division by zero point must be undefined")
	}
}

func TestEvalBranch(t *testing.T) {
	// if x <= 0 then 1 else 2
	e := If{Cond{LE, Var{0}, Const{Rat(0, 1)}}, Const{Rat(1, 1)}, Const{Rat(2, 1)}}
	if got, _ := Eval(e, env(Rat(-1, 1))); got.Cmp(Rat(1, 1)) != 0 {
		t.Fatalf("then branch: got %v", got)
	}
	if got, _ := Eval(e, env(Rat(1, 1))); got.Cmp(Rat(2, 1)) != 0 {
		t.Fatalf("else branch: got %v", got)
	}
}

func TestEvalBranchUndefCond(t *testing.T) {
	// if 1/x > 0 then 1 else 2, at x=0 the condition is undefined
	e := If{Cond{GT, Div{Const{Rat(1, 1)}, Var{0}}, Const{Rat(0, 1)}},
		Const{Rat(1, 1)}, Const{Rat(2, 1)}}
	if _, ok := Eval(e, env(Rat(0, 1))); ok {
		t.Fatal("undefined condition must make the branch undefined")
	}
}

func TestEvalIntervalBranchJoin(t *testing.T) {
	// if x <= 0 then 1 else 2 over x in [-1, 1]: both branches reachable
	e := If{Cond{LE, Var{0}, Const{Rat(0, 1)}}, Const{Rat(1, 1)}, Const{Rat(2, 1)}}
	iv, mayUndef := EvalInterval(e, []Interval{New(Rat(-1, 1), Rat(1, 1))})
	if mayUndef || iv.Lo.Cmp(Rat(1, 1)) != 0 || iv.Hi.Cmp(Rat(2, 1)) != 0 {
		t.Fatalf("join: got %v mayUndef=%v", iv, mayUndef)
	}
	// over x in [1, 2]: only the else branch
	iv, _ = EvalInterval(e, []Interval{New(Rat(1, 1), Rat(2, 1))})
	if iv.Lo.Cmp(Rat(2, 1)) != 0 || iv.Hi.Cmp(Rat(2, 1)) != 0 {
		t.Fatalf("else only: got %v", iv)
	}
}

func TestEvalIntervalDivUndef(t *testing.T) {
	e := Div{Const{Rat(1, 1)}, Var{0}}
	iv, mayUndef := EvalInterval(e, []Interval{New(Rat(-1, 1), Rat(1, 1))})
	if !iv.Undef || !mayUndef {
		t.Fatalf("div by zero-containing interval: got %v mayUndef=%v", iv, mayUndef)
	}
}

// TestDependencyProblem shows that plain interval evaluation loses
// shared-variable dependencies while grid enumeration stays exact:
// x - x over x in [0,1] is [-1,1] interval-wise but exactly 0.
func TestDependencyProblem(t *testing.T) {
	e := Sub{Var{0}, Var{0}}
	iv, _ := EvalInterval(e, []Interval{New(Rat(0, 1), Rat(1, 1))})
	if iv.Lo.Cmp(Rat(-1, 1)) != 0 || iv.Hi.Cmp(Rat(1, 1)) != 0 {
		t.Fatalf("naive interval bound: got %v", iv)
	}
	cert, err := Enumerate(e, [][]*big.Rat{{Rat(0, 1), Rat(1, 3), Rat(2, 3), Rat(1, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	if cert.Min.Sign() != 0 || cert.Max.Sign() != 0 || cert.Defined != 4 {
		t.Fatalf("exact extrema: got %v", cert)
	}
}
