package expropt

import (
	"math/rand"
	"strings"
	"testing"
)

// evalBoth evaluates the original and optimized tree and requires the
// same value or the same error (same position).
func evalBoth(t *testing.T, n Node) {
	t.Helper()
	opt := Optimize(n)
	v0, err0 := Eval(n)
	v1, err1 := Eval(opt)
	dz0, ok0 := err0.(*DivZeroError)
	dz1, ok1 := err1.(*DivZeroError)
	if ok0 != ok1 {
		t.Fatalf("error mismatch: orig=%v optimized=%v\noptimized tree:\n%s", err0, err1, Dump(opt))
	}
	if ok0 && dz0.At != dz1.At {
		t.Fatalf("error position moved: orig @%d optimized @%d\noptimized tree:\n%s", dz0.At, dz1.At, Dump(opt))
	}
	if err0 == nil && v0 != v1 {
		t.Fatalf("value mismatch: orig=%d optimized=%d\noptimized tree:\n%s", v0, v1, Dump(opt))
	}
}

func TestConstantFolding(t *testing.T) {
	n, err := Parse("1 + 2 * 3")
	if err != nil {
		t.Fatal(err)
	}
	opt := Optimize(n)
	c, ok := opt.(*Const)
	if !ok || c.Val != 7 {
		t.Fatalf("got %v, want Const(7)", Dump(opt))
	}
}

func TestDivZeroNotFolded(t *testing.T) {
	n, err := Parse("1 / 0")
	if err != nil {
		t.Fatal(err)
	}
	opt := Optimize(n) // must not panic or report an error here
	if _, ok := opt.(*Binary); !ok {
		t.Fatalf("x/0 was folded away:\n%s", Dump(opt))
	}
	if _, err := Eval(opt); err == nil {
		t.Fatal("optimized x/0 lost its runtime error")
	} else if dz := err.(*DivZeroError); dz.At != 2 {
		t.Fatalf("error at %d, want @2", dz.At)
	}
}

func TestErrorOrderPreserved(t *testing.T) {
	// The first (leftmost) division by zero must be the one reported,
	// before and after optimization.
	n, err := Parse("(1 / 0) + (2 / 0)")
	if err != nil {
		t.Fatal(err)
	}
	_, err0 := Eval(n)
	_, err1 := Eval(Optimize(n))
	// The first '/' in "(1 / 0) + (2 / 0)" is at offset 3.
	if err0.(*DivZeroError).At != 3 || err1.(*DivZeroError).At != 3 {
		t.Fatalf("got @%d and @%d, want @3 both", err0.(*DivZeroError).At, err1.(*DivZeroError).At)
	}
}

func TestUnevaluatedBranchDoesNotError(t *testing.T) {
	for _, tc := range []struct {
		src  string
		want int64
	}{
		{"0 && (1 / 0)", 0},
		{"1 || (1 / 0)", 1},
		{"0 && (1 / 0) || 5", 1},
	} {
		n, err := Parse(tc.src)
		if err != nil {
			t.Fatal(err)
		}
		opt := Optimize(n)
		v, err := Eval(opt)
		if err != nil {
			t.Fatalf("%s: optimized tree errored: %v\n%s", tc.src, err, Dump(opt))
		}
		if v != tc.want {
			t.Fatalf("%s: got %d, want %d", tc.src, v, tc.want)
		}
		// The dead branch must be gone entirely.
		if MayError(opt) {
			t.Fatalf("%s: dead branch survived optimization:\n%s", tc.src, Dump(opt))
		}
	}
}

func TestShortCircuitSimplification(t *testing.T) {
	n, err := Parse("1 && (xless)")
	if err == nil {
		t.Fatal("unexpected parse success")
	}
	// 2 && (3 < 4) -> Truthy folds to Const(1)
	n, err = Parse("2 && (3 < 4)")
	if err != nil {
		t.Fatal(err)
	}
	if c, ok := Optimize(n).(*Const); !ok || c.Val != 1 {
		t.Fatalf("got:\n%s", Dump(Optimize(n)))
	}
}

func TestZeroMulKeepsError(t *testing.T) {
	// 0 * (1/0) must still error: the interpreter evaluates both sides.
	n, err := Parse("0 * (1 / 0)")
	if err != nil {
		t.Fatal(err)
	}
	opt := Optimize(n)
	if _, err := Eval(opt); err == nil {
		t.Fatalf("0 * (1/0) lost its error:\n%s", Dump(opt))
	}
	// But 0 * (1/2) folds to 0 (right side cannot error).
	n, _ = Parse("0 * (1 / 2)")
	if c, ok := Optimize(n).(*Const); !ok || c.Val != 0 {
		t.Fatalf("got:\n%s", Dump(Optimize(n)))
	}
}

func TestDumpShowsPositions(t *testing.T) {
	src := "1 + 20 / (3 - 1)"
	n, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	out := Dump(Optimize(n))
	if !strings.Contains(out, "@") {
		t.Fatalf("no positions in dump:\n%s", out)
	}
	// 20/2 folds to 10; 1+10 folds to 11.
	want := "Const(11) @2\n"
	if out != want {
		t.Fatalf("got %q, want %q", out, want)
	}
}

// --- randomized differential testing against the interpreter ---

type gen struct {
	r   *rand.Rand
	pos int
}

func (g *gen) const_() Node {
	v := int64(g.r.Intn(5) - 1) // -1..3, plenty of zeros
	at := g.pos
	g.pos++
	return &Const{Val: v, At: at}
}

func (g *gen) expr(depth int) Node {
	if depth == 0 || g.r.Intn(3) == 0 {
		return g.const_()
	}
	ops := []Op{Add, Sub, Mul, Div, Eq, Ne, Lt, Le, Gt, Ge, And, Or}
	op := ops[g.r.Intn(len(ops))]
	l := g.expr(depth - 1)
	at := g.pos
	g.pos++
	r := g.expr(depth - 1)
	return &Binary{Op: op, L: l, R: r, At: at}
}

func TestRandomizedDifferential(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for i := 0; i < 50000; i++ {
		g := &gen{r: r}
		n := g.expr(4)
		evalBoth(t, n)
	}
}

func TestRandomizedParsedRoundTrip(t *testing.T) {
	// Expressions rendered as source, parsed, then compared: exercises
	// positions and the parser together with the optimizer.
	r := rand.New(rand.NewSource(2))
	for i := 0; i < 20000; i++ {
		g := &gen{r: r}
		n := g.expr(3)
		src := render(n)
		parsed, err := Parse(src)
		if err != nil {
			t.Fatalf("parse %q: %v", src, err)
		}
		evalBoth(t, parsed)
	}
}

func render(n Node) string {
	switch n := n.(type) {
	case *Const:
		if n.Val < 0 {
			return "(0-" + itoa(-n.Val) + ")"
		}
		return itoa(n.Val)
	case *Binary:
		return "(" + render(n.L) + n.Op.String() + render(n.R) + ")"
	}
	panic("unreachable")
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}
