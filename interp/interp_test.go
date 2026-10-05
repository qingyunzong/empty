package interp_test

import (
	"strings"
	"testing"

	"example.com/debuglib/interp"
)

const sumProg = `
# sum of 1..5
let i = 1
let sum = 0
loop:
if i > 5 goto done
sum = sum + i
i = i + 1
goto loop
done:
print sum
end
`

func TestRunSumProgram(t *testing.T) {
	prog, err := interp.Parse(sumProg)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	vm := interp.NewVM(prog)
	if err := vm.Run(); err != nil {
		t.Fatalf("run: %v", err)
	}
	if got := vm.Vars["sum"]; got != 15 {
		t.Errorf("sum = %d, want 15", got)
	}
	if got := vm.Vars["i"]; got != 6 {
		t.Errorf("i = %d, want 6", got)
	}
	if len(vm.Out) != 1 || vm.Out[0] != 15 {
		t.Errorf("Out = %v, want [15]", vm.Out)
	}
}

func TestStatementErrorLeavesStateUnchanged(t *testing.T) {
	prog, err := interp.Parse("let x = 1\nprint missing\nprint x\nend\n")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	vm := interp.NewVM(prog)
	err = vm.Run()
	if err == nil || !strings.Contains(err.Error(), "undefined variable") {
		t.Fatalf("err = %v, want undefined variable", err)
	}
	if vm.PC != 1 {
		t.Errorf("PC = %d, want 1 (failed statement not consumed)", vm.PC)
	}
	if len(vm.Out) != 0 {
		t.Errorf("Out = %v, want empty", vm.Out)
	}
	if vm.Vars["x"] != 1 {
		t.Errorf("x = %d, want 1", vm.Vars["x"])
	}
}

func TestDivisionByZero(t *testing.T) {
	prog, err := interp.Parse("let x = 1 / 0\nend\n")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	vm := interp.NewVM(prog)
	if err := vm.Run(); err == nil || !strings.Contains(err.Error(), "division by zero") {
		t.Fatalf("err = %v, want division by zero", err)
	}
	if _, ok := vm.Vars["x"]; ok {
		t.Errorf("x was assigned despite failed statement")
	}
}

func TestUndefinedLabel(t *testing.T) {
	prog, err := interp.Parse("goto nowhere\nend\n")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	vm := interp.NewVM(prog)
	if err := vm.Run(); err == nil || !strings.Contains(err.Error(), "undefined label") {
		t.Fatalf("err = %v, want undefined label", err)
	}
}

func TestExprIsPure(t *testing.T) {
	for _, src := range []string{"1 + 2 * 3", "x < y", "(a + b) % 2 == 0", "-x", "!(x == 0)"} {
		e, err := interp.ParseExpr(src)
		if err != nil {
			t.Fatalf("ParseExpr(%q): %v", src, err)
		}
		if !interp.IsPure(e) {
			t.Errorf("IsPure(%q) = false, want true", src)
		}
	}
}

func TestParseExprRejectsNonExpressions(t *testing.T) {
	for _, src := range []string{"x = 1", "print x", "goto loop", "x y", ""} {
		if _, err := interp.ParseExpr(src); err == nil {
			t.Errorf("ParseExpr(%q) succeeded, want error", src)
		}
	}
}

func TestParseErrors(t *testing.T) {
	for _, src := range []string{
		"let = 1",
		"x = ",
		"if x > 1 then",
		"foo:\nfoo:\nend",
		"let x = 1 garbage",
	} {
		if _, err := interp.Parse(src); err == nil {
			t.Errorf("Parse(%q) succeeded, want error", src)
		}
	}
}
