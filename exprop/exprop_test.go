package exprop

import (
	"fmt"

	"testing"
)

func p(line, col int) Pos { return Pos{Offset: line*100 + col, Line: line, Column: col} }

func c(v int64, line, col int) *Const { return &Const{Val: v, At: p(line, col)} }

func bin(op Op, l, r Expr, line, col int) *Binary {
	return &Binary{Op: op, L: l, R: r, At: p(line, col)}
}

func mustVal(t *testing.T, e Expr, want int64) {
	t.Helper()
	got, err := Eval(e)
	if err != nil {
		t.Fatalf("Eval(%s) returned error %v, want %d", Dump(e), err, want)
	}
	if got != want {
		t.Fatalf("Eval(%s) = %d, want %d", Dump(e), got, want)
	}
}

func mustErrAt(t *testing.T, e Expr, want Pos) {
	t.Helper()
	_, err := Eval(e)
	ee, ok := err.(*EvalError)
	if !ok {
		t.Fatalf("Eval(%s) = %v, want *EvalError at %s", Dump(e), err, want)
	}
	if ee.At != want {
		t.Fatalf("Eval(%s) error at %s, want %s", Dump(e), ee.At, want)
	}
}

func TestConstantFolding(t *testing.T) {
	// (2 + 3) * 4 folds to a single constant.
	e := bin(OpMul, bin(OpAdd, c(2, 1, 1), c(3, 1, 3), 1, 2), c(4, 1, 6), 1, 5)
	opt := Optimize(e)
	k, ok := opt.(*Const)
	if !ok {
		t.Fatalf("Optimize did not fold to Const: %s", Dump(opt))
	}
	if k.Val != 20 {
		t.Fatalf("folded value = %d, want 20", k.Val)
	}
	mustVal(t, opt, 20)
}

func TestShortCircuitDropsDeadBranch(t *testing.T) {
	// 0 && (1/0): the right side is never evaluated, so it may be dropped.
	e := bin(OpAnd, c(0, 1, 1), bin(OpDiv, c(1, 1, 5), c(0, 1, 7), 1, 6), 1, 3)
	opt := Optimize(e)
	if k, ok := opt.(*Const); !ok || k.Val != 0 {
		t.Fatalf("Optimize = %s, want constant 0", Dump(opt))
	}
	mustVal(t, opt, 0)

	// 1 || (1/0) folds to 1.
	e2 := bin(OpOr, c(1, 1, 1), bin(OpDiv, c(1, 1, 5), c(0, 1, 7), 1, 6), 1, 3)
	mustVal(t, Optimize(e2), 1)
}

func TestUnevaluatedCondBranchDoesNotError(t *testing.T) {
	// 1 ? 7 : (1/0) -> 7; the dead branch's divide by zero must not surface.
	e := &Cond{C: c(1, 1, 1), T: c(7, 1, 5), F: bin(OpDiv, c(1, 1, 9), c(0, 1, 11), 1, 10), At: p(1, 3)}
	opt := Optimize(e)
	mustVal(t, opt, 7)
	if k, ok := opt.(*Const); !ok || k.Val != 7 {
		t.Fatalf("Optimize = %s, want constant 7", Dump(opt))
	}

	// 0 ? (1/0) : 9 -> 9.
	e2 := &Cond{C: c(0, 1, 1), T: bin(OpDiv, c(1, 1, 5), c(0, 1, 7), 1, 6), F: c(9, 1, 9), At: p(1, 3)}
	mustVal(t, Optimize(e2), 9)
}

func TestDivZeroOrderPreserved(t *testing.T) {
	// (1/0) + (2/0): the left error is observed first, before and after.
	e := bin(OpAdd,
		bin(OpDiv, c(1, 1, 1), c(0, 1, 3), 1, 2),
		bin(OpDiv, c(2, 1, 5), c(0, 1, 7), 1, 6),
		1, 4)
	mustErrAt(t, e, p(1, 2))
	mustErrAt(t, Optimize(e), p(1, 2))

	// (1+1) + (1/0): folding the pure left side must not reorder errors.
	e2 := bin(OpAdd,
		bin(OpAdd, c(1, 1, 1), c(1, 1, 3), 1, 2),
		bin(OpDiv, c(1, 1, 5), c(0, 1, 7), 1, 6),
		1, 4)
	mustErrAt(t, Optimize(e2), p(1, 6))
}

func TestImpureSubexpressionNotDropped(t *testing.T) {
	// (1/0) * 0 must NOT fold to 0: the divide by zero is observable.
	e := bin(OpMul, bin(OpDiv, c(1, 1, 1), c(0, 1, 3), 1, 2), c(0, 1, 5), 1, 4)
	opt := Optimize(e)
	mustErrAt(t, opt, p(1, 2))

	// (2+3) * 0 is pure, so it may fold to 0.
	e2 := bin(OpMul, bin(OpAdd, c(2, 1, 1), c(3, 1, 3), 1, 2), c(0, 1, 5), 1, 4)
	mustVal(t, Optimize(e2), 0)
}

func TestShortCircuitIdentities(t *testing.T) {
	// 1 && x becomes (x != 0); errors in x still surface in order.
	x := bin(OpDiv, c(6, 1, 5), c(2, 1, 7), 1, 6)
	e := bin(OpAnd, c(1, 1, 1), x, 1, 3)
	mustVal(t, Optimize(e), 1)

	bad := bin(OpAnd, c(2, 1, 1), bin(OpDiv, c(1, 1, 5), c(0, 1, 7), 1, 6), 1, 3)
	mustErrAt(t, Optimize(bad), p(1, 6))

	// 0 || x becomes (x != 0).
	e2 := bin(OpOr, c(0, 1, 1), c(5, 1, 5), 1, 3)
	mustVal(t, Optimize(e2), 1)
}

func TestDumpIncludesPositions(t *testing.T) {
	e := bin(OpAdd, c(2, 1, 1), c(3, 1, 5), 1, 3)
	got := Dump(e)
	want := "(+@1:3 2@1:1 3@1:5)"
	if got != want {
		t.Fatalf("Dump = %q, want %q", got, want)
	}
}

func ExampleOptimize() {
	// (2 + 3) * (1 ? 4 : 1/0) && (10 % 3)
	e := bin(OpAnd,
		bin(OpMul,
			bin(OpAdd, c(2, 1, 1), c(3, 1, 3), 1, 2),
			&Cond{C: c(1, 1, 7), T: c(4, 1, 11), F: bin(OpDiv, c(1, 1, 15), c(0, 1, 17), 1, 16), At: p(1, 9)},
			1, 5),
		bin(OpMod, c(10, 1, 22), c(3, 1, 25), 1, 24),
		1, 19)
	opt := Optimize(e)
	fmt.Println("original :", Dump(e))
	fmt.Println("optimized:", Dump(opt))
	v, err := Eval(opt)
	fmt.Println("value    :", v, err)
	// Output:
	// original : (&&@1:19 (*@1:5 (+@1:2 2@1:1 3@1:3) (?:@1:9 1@1:7 4@1:11 (/@1:16 1@1:15 0@1:17))) (%@1:24 10@1:22 3@1:25))
	// optimized: 1@1:19
	// value    : 1 <nil>
}
