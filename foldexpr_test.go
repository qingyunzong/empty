package foldexpr

import (
	"strings"
	"testing"
)

func mustParse(t *testing.T, src string) Node {
	t.Helper()
	n, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse(%q): %v", src, err)
	}
	return n
}

func mustFold(t *testing.T, src string) Node {
	t.Helper()
	return Fold(mustParse(t, src))
}

func wantConst(t *testing.T, n Node, val int32) {
	t.Helper()
	c, ok := n.(*Const)
	if !ok {
		t.Fatalf("expected Const(%d), got %s", val, Dump(n))
	}
	if c.Val != val {
		t.Fatalf("expected Const(%d), got Const(%d)", val, c.Val)
	}
}

func TestFoldConstantArithmetic(t *testing.T) {
	wantConst(t, mustFold(t, "1 + 2 * 3"), 7)
	wantConst(t, mustFold(t, "(1 + 2) * 3"), 9)
	wantConst(t, mustFold(t, "10 / 3"), 3)
	wantConst(t, mustFold(t, "10 % 3"), 1)
	wantConst(t, mustFold(t, "-5 + 5"), 0)
	wantConst(t, mustFold(t, "2 < 3 && 3 >= 3"), 1)
	wantConst(t, mustFold(t, "1 == 2 || 2 == 2"), 1)
	wantConst(t, mustFold(t, "!(1 != 1)"), 1)
}

func TestWrapAround32Bit(t *testing.T) {
	wantConst(t, mustFold(t, "2147483647 + 1"), -2147483648)
	wantConst(t, mustFold(t, "-2147483648 - 1"), 2147483647)
	wantConst(t, mustFold(t, "100000 * 100000"), 1410065408) // 1e10 mod 2^32
	wantConst(t, mustFold(t, "2147483648"), -2147483648)     // literal wraps
	wantConst(t, mustFold(t, "-2147483648 / -1"), -2147483648)
	wantConst(t, mustFold(t, "-2147483648 % -1"), 0)

	v, err := Eval(mustParse(t, "2147483647 + x"), map[string]int32{"x": 1})
	if err != nil || v != -2147483648 {
		t.Fatalf("Eval wraparound: got %d, %v", v, err)
	}
}

func TestShortCircuitDivZeroNotAnError(t *testing.T) {
	// Division by zero in a branch that short-circuit eliminates must
	// neither fail folding nor trap at run time.
	cases := []struct {
		src  string
		want int32
	}{
		{"0 && 1 / 0", 0},
		{"1 || 1 / 0", 1},
		{"1 ? 2 : 1 / 0", 2},
		{"0 ? 1 / 0 : 3", 3},
		{"0 && 1 % 0", 0},
		{"2 + (0 && 5 / 0)", 2},
	}
	for _, tc := range cases {
		f := mustFold(t, tc.src)
		wantConst(t, f, tc.want)
		v, err := Eval(f, nil)
		if err != nil {
			t.Fatalf("Eval(Fold(%q)): unexpected error %v", tc.src, err)
		}
		if v != tc.want {
			t.Fatalf("Eval(Fold(%q)) = %d, want %d", tc.src, v, tc.want)
		}
	}
}

func TestMandatoryDivZeroBecomesRuntimeTrap(t *testing.T) {
	src := "1 / 0"
	f := mustFold(t, src)
	tr, ok := f.(*Trap)
	if !ok {
		t.Fatalf("Fold(%q): expected *Trap, got %s", src, Dump(f))
	}
	if tr.P != strings.Index(src, "/") {
		t.Fatalf("trap pos %d, want %d", tr.P, strings.Index(src, "/"))
	}
	_, err := Eval(f, nil)
	te, ok := err.(*TrapError)
	if !ok {
		t.Fatalf("Eval(Fold(%q)): expected *TrapError, got %v", src, err)
	}
	if te.Pos != strings.Index(src, "/") {
		t.Fatalf("trap error pos %d, want %d", te.Pos, strings.Index(src, "/"))
	}
}

func TestTrapPositionPreservedThroughFold(t *testing.T) {
	src := "3 + 10 % 0"
	f := mustFold(t, src)
	_, err := Eval(f, nil)
	te, ok := err.(*TrapError)
	if !ok {
		t.Fatalf("expected *TrapError, got %v", err)
	}
	if te.Pos != strings.Index(src, "%") {
		t.Fatalf("trap pos %d, want %d", te.Pos, strings.Index(src, "%"))
	}
}

func TestRuntimeDivZeroNotFolded(t *testing.T) {
	// Non-constant divisor: stays in the AST, traps only when the
	// divisor is actually zero at run time.
	src := "x / y"
	f := mustFold(t, src)
	if _, ok := f.(*Binary); !ok {
		t.Fatalf("Fold(%q) should keep Binary, got %s", src, Dump(f))
	}
	if v, err := Eval(f, map[string]int32{"x": 7, "y": 2}); err != nil || v != 3 {
		t.Fatalf("Eval = %d, %v; want 3, nil", v, err)
	}
	_, err := Eval(f, map[string]int32{"x": 7, "y": 0})
	te, ok := err.(*TrapError)
	if !ok || te.Pos != strings.Index(src, "/") {
		t.Fatalf("expected trap at %d, got %v", strings.Index(src, "/"), err)
	}
}

func TestShortCircuitAtRuntime(t *testing.T) {
	src := "x && 1 / 0"
	f := mustFold(t, src)
	if v, err := Eval(f, map[string]int32{"x": 0}); err != nil || v != 0 {
		t.Fatalf("x=0: got %d, %v; want 0, nil", v, err)
	}
	_, err := Eval(f, map[string]int32{"x": 5})
	te, ok := err.(*TrapError)
	if !ok || te.Pos != strings.Index(src, "/") {
		t.Fatalf("x=5: expected trap at %d, got %v", strings.Index(src, "/"), err)
	}
}

func TestTrapSurvivesIdentityFold(t *testing.T) {
	// (1/0) * 0 must not fold to 0: the trap is mandatory.
	f := mustFold(t, "(1 / 0) * 0")
	if _, ok := f.(*Const); ok {
		t.Fatalf("trap was folded away: %s", Dump(f))
	}
	if _, err := Eval(f, nil); err == nil {
		t.Fatalf("expected trap, got nil")
	}
}

func TestUndefinedVariable(t *testing.T) {
	_, err := Eval(mustParse(t, "x + 1"), nil)
	ue, ok := err.(*UndefinedError)
	if !ok || ue.Name != "x" || ue.Pos != 0 {
		t.Fatalf("expected UndefinedError for x at 0, got %v", err)
	}
}

func TestDumpAndString(t *testing.T) {
	n := mustParse(t, "1 + 2 * 3")
	if got := n.String(); got != "(1 + (2 * 3))" {
		t.Fatalf("String() = %q", got)
	}
	d := Dump(n)
	for _, want := range []string{"Binary(+) @2", "Const(1) @0", "Binary(*) @6"} {
		if !strings.Contains(d, want) {
			t.Fatalf("Dump missing %q:\n%s", want, d)
		}
	}
	fd := Dump(mustFold(t, "1 + 2 * 3"))
	if !strings.Contains(fd, "Const(7)") {
		t.Fatalf("Dump of folded expr missing Const(7):\n%s", fd)
	}
}

func TestPosition(t *testing.T) {
	src := "a +\nb / 0"
	line, col := Position(src, strings.Index(src, "/"))
	if line != 2 || col != 3 {
		t.Fatalf("Position = %d:%d, want 2:3", line, col)
	}
}

func TestParseErrors(t *testing.T) {
	for _, src := range []string{"1 +", "(1", "1 2", "@", "1 ? 2"} {
		if _, err := Parse(src); err == nil {
			t.Fatalf("Parse(%q): expected error", src)
		}
	}
}
