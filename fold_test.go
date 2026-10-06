package intfold

import (
	"strings"
	"testing"
)

func mustParse(t *testing.T, src string) *Expr {
	t.Helper()
	e, err := Parse(src)
	if err != nil {
		t.Fatalf("Parse(%q): %v", src, err)
	}
	return e
}

// Short-circuited division by zero must not become a compile-time error:
// the dead branch is discarded and the result is a plain constant.
func TestFoldShortCircuitedDivZero(t *testing.T) {
	cases := []struct {
		src  string
		want int32
	}{
		{"0 && 1 / 0", 0},
		{"1 || 1 % 0", 1},
		{"1 ? 42 : 1 / 0", 42},
		{"0 ? 1 / 0 : 42", 42},
		{"0 && (1 / 0 + 2)", 0},
		{"2 && 1", 1}, // non-zero left reduces && to right operand
		{"0 || 7", 1}, // zero left reduces || to truth value of right operand
	}
	for _, c := range cases {
		f := Fold(mustParse(t, c.src))
		if f.Kind != Const || f.Val != c.want {
			t.Errorf("Fold(%q) = %v (val %d), want const %d", c.src, f.Kind, f.Val, c.want)
		}
		if f.Kind == Const && len(f.Prov) == 0 {
			t.Errorf("Fold(%q): missing provenance note", c.src)
		}
	}
}

// A must-execute constant division by zero folds to a TrapNode, not a
// compile error, and the trap fires at run time with the original span.
func TestFoldMustExecuteDivZeroBecomesTrapNode(t *testing.T) {
	for _, src := range []string{"1 / 0", "1 % 0", "2 + 1 / 0", "1 && 1 / 0"} {
		e := mustParse(t, src)
		f := Fold(e)
		v, tr := Eval(f, nil)
		if tr == nil {
			t.Fatalf("Fold(%q): expected run-time trap, got value %d", src, v)
		}
		// The trap position must match the original expression's fault.
		_, trOrig := Eval(e, nil)
		if trOrig == nil {
			t.Fatalf("Eval(%q): original did not trap", src)
		}
		if tr.Span != trOrig.Span {
			t.Errorf("Fold(%q): trap span %v, original %v", src, tr.Span, trOrig.Span)
		}
	}
}

// The trap node sits under the guard: with x == 0 nothing traps.
func TestTrapNodeUnderGuard(t *testing.T) {
	e := mustParse(t, "x && 1 / 0")
	f := Fold(e)
	if v, tr := Eval(f, map[string]int32{"x": 0}); tr != nil || v != 0 {
		t.Errorf("x=0: got (%d, %v), want (0, nil)", v, tr)
	}
	if _, tr := Eval(f, map[string]int32{"x": 1}); tr == nil {
		t.Error("x=1: expected trap")
	}
}

func TestWraparound(t *testing.T) {
	cases := []struct {
		src  string
		want int32
	}{
		{"2147483647 + 1", -2147483648},
		{"-2147483648 - 1", 2147483647},
		{"65536 * 65536", 0},
		{"-2147483648 / -1", -2147483648}, // wraps, no trap
		{"-2147483648 % -1", 0},
		{"- -2147483648", -2147483648}, // negation wraps
		{"4294967296", 0},              // literal wraps at parse
	}
	for _, c := range cases {
		e := mustParse(t, c.src)
		if v, tr := Eval(e, nil); tr != nil || v != c.want {
			t.Errorf("Eval(%q) = (%d, %v), want (%d, nil)", c.src, v, tr, c.want)
		}
		f := Fold(e)
		if f.Kind != Const || f.Val != c.want {
			t.Errorf("Fold(%q) = (%v, %d), want const %d", c.src, f.Kind, f.Val, c.want)
		}
	}
}

func TestFoldDoesNotMutateInput(t *testing.T) {
	e := mustParse(t, "x + 2 * 3")
	before := Dump(e)
	_ = Fold(e)
	if Dump(e) != before {
		t.Error("Fold mutated the input AST")
	}
}

func TestDumpIncludesSpanAndProvenance(t *testing.T) {
	f := Fold(mustParse(t, "1 / 0"))
	out := Dump(f)
	if !strings.Contains(out, "TRAP") || !strings.Contains(out, "[0:5]") {
		t.Errorf("Dump missing trap/span info:\n%s", out)
	}
	if !strings.Contains(out, "# ") {
		t.Errorf("Dump missing provenance:\n%s", out)
	}
}

func TestParseErrors(t *testing.T) {
	for _, src := range []string{"1 +", "(1", "1 2", "1 ?", "@"} {
		if _, err := Parse(src); err == nil {
			t.Errorf("Parse(%q): expected error", src)
		}
	}
}

func TestUndefinedVariableTraps(t *testing.T) {
	e := mustParse(t, "y + 1")
	if _, tr := Eval(e, nil); tr == nil {
		t.Error("expected trap for undefined variable")
	}
}
