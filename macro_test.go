package macro

import (
	"errors"
	"strings"
	"testing"
)

func mustRun(t *testing.T, src string, budget int) Value {
	t.Helper()
	v, _, _, err := RunProgram(src, budget)
	if err != nil {
		t.Fatalf("RunProgram(%q) error: %v", src, err)
	}
	return v
}

// TestHandWrittenScopeModel verifies the scope model by constructing
// frames, a macro and a call site directly in Go, without the parser.
func TestHandWrittenScopeModel(t *testing.T) {
	globals := NewGlobalEnv()
	globals.Define("n", Int(10))

	caller := NewEnv(globals)
	caller.Define("n", Int(99))

	grandchild := NewEnv(caller)

	// Lexical lookup walks the frame chain; shadowing is frame-local.
	if v, ok := caller.Lookup("n"); !ok || v != Int(99) {
		t.Fatalf("caller n = %v, %v; want 99, true", v, ok)
	}
	if v, ok := globals.Lookup("n"); !ok || v != Int(10) {
		t.Fatalf("globals n = %v, %v; want 10, true", v, ok)
	}
	if v, ok := grandchild.Lookup("n"); !ok || v != Int(99) {
		t.Fatalf("grandchild n = %v, %v; want 99, true (inherited)", v, ok)
	}
	grandchild.Define("n", Int(7))
	if v, _ := caller.Lookup("n"); v != Int(99) {
		t.Fatalf("defining in grandchild mutated caller: n = %v", v)
	}
	if _, ok := globals.Lookup("missing"); ok {
		t.Fatal("lookup of undefined symbol succeeded")
	}

	// Hand-built macro: (defmacro getn () (list '+ n 1))
	// Its free variable n must resolve in the definition frame (10),
	// not in the caller frame (99).
	getn := &Macro{
		Name:   "getn",
		Params: nil,
		Body:   List{Symbol("list"), List{Symbol("quote"), Symbol("+")}, Symbol("n"), Int(1)},
		DefEnv: globals,
	}
	globals.Define("getn", getn)

	x := NewExpander(100)
	expanded, err := x.Expand(caller, List{Symbol("getn")})
	if err != nil {
		t.Fatalf("expand: %v", err)
	}
	want := List{Symbol("+"), Int(10), Int(1)}
	tmpl, ok := expanded.(List)
	if !ok || len(tmpl) != 3 || tmpl[0] != want[0] || tmpl[1] != want[1] || tmpl[2] != want[2] {
		t.Fatalf("expanded template = %v; want %v", expanded, want)
	}
	v, err := Eval(caller, expanded)
	if err != nil {
		t.Fatalf("eval: %v", err)
	}
	if v != Int(11) {
		t.Fatalf("value = %v; want 11 (lexical n=10), not 100 (caller n=99)", v)
	}
}

// TestParametersAndArgumentEvaluation checks that arguments are
// evaluated in the caller environment before substitution.
func TestParametersAndArgumentEvaluation(t *testing.T) {
	v := mustRun(t, `
		(defmacro sq (x) (list '* x x))
		(def a 4)
		(sq (+ a 1))
	`, 100)
	if v != Int(25) {
		t.Fatalf("sq (+ a 1) = %v; want 25", v)
	}

	// The expanded template must contain the evaluated argument 5,
	// not the unevaluated expression (+ a 1).
	env := NewGlobalEnv()
	x := NewExpander(100)
	if _, err := Run(env, x, List{Symbol("defmacro"), Symbol("sq"), List{Symbol("x")},
		List{Symbol("list"), List{Symbol("quote"), Symbol("*")}, Symbol("x"), Symbol("x")}}); err != nil {
		t.Fatal(err)
	}
	if _, err := Run(env, x, List{Symbol("def"), Symbol("a"), Int(4)}); err != nil {
		t.Fatal(err)
	}
	expanded, err := x.Expand(env, List{Symbol("sq"), List{Symbol("+"), Symbol("a"), Int(1)}})
	if err != nil {
		t.Fatal(err)
	}
	tmpl, ok := expanded.(List)
	if !ok || len(tmpl) != 3 || tmpl[0] != Symbol("*") || tmpl[1] != Int(5) || tmpl[2] != Int(5) {
		t.Fatalf("template = %v; want (* 5 5): args must be evaluated in caller env first", expanded)
	}
}

// TestLocalDefinitions checks let inside macro bodies, including
// nested shadowing.
func TestLocalDefinitions(t *testing.T) {
	v := mustRun(t, `
		(defmacro two-plus (x) (let ((y 2)) (list '+ x y)))
		(two-plus 5)
	`, 100)
	if v != Int(7) {
		t.Fatalf("two-plus 5 = %v; want 7", v)
	}

	v = mustRun(t, `
		(defmacro pick (x)
			(let ((y 1))
				(let ((y 2))
					(list '+ x y))))
		(pick 10)
	`, 100)
	if v != Int(12) {
		t.Fatalf("nested let shadowing: got %v; want 12 (inner y=2)", v)
	}
}

// TestLexicalScoping: free variables of a macro body resolve in the
// definition environment, while symbols the macro deliberately emits
// resolve at the call site.
func TestLexicalScoping(t *testing.T) {
	v := mustRun(t, `
		(def g 100)
		(defmacro body-g () (list '+ g 1))
		(let ((g 1)) (body-g))
	`, 100)
	if v != Int(101) {
		t.Fatalf("body-g = %v; want 101 (definition-env g=100), not 2 (caller g=1)", v)
	}

	v = mustRun(t, `
		(defmacro emit-g () (list '+ 'g 1))
		(let ((g 1)) (emit-g))
	`, 100)
	if v != Int(2) {
		t.Fatalf("emit-g = %v; want 2 (emitted symbol resolves at call site)", v)
	}
}

// TestHygienicNoCapture: the macro introduces a temporary tmp and also
// emits a reference to the caller's variable tmp (passed as a quoted
// symbol). Expansion must not capture the caller's tmp.
func TestHygienicNoCapture(t *testing.T) {
	v := mustRun(t, `
		(defmacro add1 (var) (list 'let (list (list 'tmp 1)) (list '+ 'tmp var)))
		(let ((tmp 41)) (add1 'tmp))
	`, 100)
	if v != Int(42) {
		t.Fatalf("add1 = %v; want 42 (1 + caller tmp 41); got capture if 2", v)
	}
}

// TestRecursiveExpansionCallChain: self-recursive and mutually
// recursive macros are reported with the full call chain.
func TestRecursiveExpansionCallChain(t *testing.T) {
	_, _, _, err := RunProgram(`
		(defmacro loop () '(loop))
		(loop)
	`, 1000)
	var rec *RecursionError
	if !errors.As(err, &rec) {
		t.Fatalf("expected RecursionError, got %v", err)
	}
	if len(rec.Chain) != 2 || rec.Chain[0] != "loop" || rec.Chain[1] != "loop" {
		t.Fatalf("chain = %v; want [loop loop]", rec.Chain)
	}
	if !strings.Contains(err.Error(), "loop -> loop") {
		t.Fatalf("error %q does not contain call chain", err)
	}

	_, _, _, err = RunProgram(`
		(defmacro ma () '(mb))
		(defmacro mb () '(ma))
		(ma)
	`, 1000)
	if !errors.As(err, &rec) {
		t.Fatalf("expected RecursionError, got %v", err)
	}
	want := []Symbol{"ma", "mb", "ma"}
	if len(rec.Chain) != len(want) {
		t.Fatalf("chain = %v; want %v", rec.Chain, want)
	}
	for i := range want {
		if rec.Chain[i] != want[i] {
			t.Fatalf("chain = %v; want %v", rec.Chain, want)
		}
	}
	if !strings.Contains(err.Error(), "ma -> mb -> ma") {
		t.Fatalf("error %q does not contain call chain", err)
	}
}

// TestStepBudget: a program needs a definite number of expansion steps.
// With exactly that budget it closes; with one fewer step the expansion
// is returned as unclosed (BudgetError carrying the call chain).
func TestStepBudget(t *testing.T) {
	src := `
		(defmacro mc () 1)
		(defmacro mb () (list '+ '(mc) 1))
		(defmacro ma () (list '+ '(mb) 1))
		(ma)
	`
	v, _, x, err := RunProgram(src, 100000)
	if err != nil {
		t.Fatalf("unlimited run: %v", err)
	}
	if v != Int(3) {
		t.Fatalf("value = %v; want 3", v)
	}
	need := x.StepsUsed
	if need <= 0 {
		t.Fatalf("StepsUsed = %d; want > 0", need)
	}

	// Exactly the required budget closes.
	v, _, _, err = RunProgram(src, need)
	if err != nil {
		t.Fatalf("budget=%d (exact): unexpected error %v", need, err)
	}
	if v != Int(3) {
		t.Fatalf("budget=%d (exact): value = %v; want 3", need, v)
	}

	// One step short: budget is returned unclosed.
	_, _, _, err = RunProgram(src, need-1)
	var berr *BudgetError
	if !errors.As(err, &berr) {
		t.Fatalf("budget=%d: expected BudgetError, got %v", need-1, err)
	}
	if !strings.Contains(err.Error(), "unclosed") {
		t.Fatalf("error %q does not report unclosed budget", err)
	}
	if len(berr.Chain) == 0 || berr.Chain[0] != "ma" {
		t.Fatalf("BudgetError chain = %v; want it to start at ma", berr.Chain)
	}

	// A tiny budget fails immediately, also unclosed.
	_, _, _, err = RunProgram(src, 1)
	if !errors.As(err, &berr) {
		t.Fatalf("budget=1: expected BudgetError, got %v", err)
	}
}

// TestArityAndUndefined covers basic error paths.
func TestArityAndUndefined(t *testing.T) {
	_, _, _, err := RunProgram(`
		(defmacro one (x) x)
		(one 1 2)
	`, 100)
	if err == nil || !strings.Contains(err.Error(), "expected 1 args, got 2") {
		t.Fatalf("arity error = %v", err)
	}

	_, _, _, err = RunProgram(`(nosuch 1)`, 100)
	if err == nil || !strings.Contains(err.Error(), "undefined symbol") {
		t.Fatalf("undefined error = %v", err)
	}
}

// TestHygienicTemplateShape inspects the expanded template directly:
// the macro's temporary must be renamed to a fresh symbol, while the
// caller-injected symbol keeps its name.
func TestHygienicTemplateShape(t *testing.T) {
	env := NewGlobalEnv()
	x := NewExpander(100)
	forms, err := Parse(`(defmacro add1 (var) (list 'let (list (list 'tmp 1)) (list '+ 'tmp var)))`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Run(env, x, forms[0]); err != nil {
		t.Fatal(err)
	}
	call, err := Parse(`(add1 'tmp)`)
	if err != nil {
		t.Fatal(err)
	}
	expanded, err := x.Expand(env, call[0])
	if err != nil {
		t.Fatal(err)
	}
	tmpl, ok := expanded.(List)
	if !ok || len(tmpl) != 3 || tmpl[0] != Symbol("let") {
		t.Fatalf("template = %v; want a let form", expanded)
	}
	binds, ok := tmpl[1].(List)
	if !ok || len(binds) != 1 {
		t.Fatalf("template binds = %v", tmpl[1])
	}
	pair, ok := binds[0].(List)
	if !ok || len(pair) != 2 {
		t.Fatalf("template binding = %v", binds[0])
	}
	fresh, ok := pair[0].(Symbol)
	if !ok || fresh == "tmp" || !strings.HasPrefix(string(fresh), "tmp__") {
		t.Fatalf("macro temp = %v; want a fresh tmp__N name", pair[0])
	}
	body, ok := tmpl[2].(List)
	if !ok || len(body) != 3 || body[0] != Symbol("+") {
		t.Fatalf("template body = %v", tmpl[2])
	}
	if body[1] != fresh {
		t.Fatalf("macro temp use = %v; want renamed %v", body[1], fresh)
	}
	if body[2] != Symbol("tmp") {
		t.Fatalf("caller symbol = %v; want untouched tmp", body[2])
	}
}

// TestArgumentValueNotCaptured: passing the caller's tmp by value —
// the macro's same-named temporary cannot capture it.
func TestArgumentValueNotCaptured(t *testing.T) {
	v := mustRun(t, `
		(def tmp 41)
		(defmacro add1 (x) (list 'let (list (list 'tmp 1)) (list '+ 'tmp x)))
		(add1 tmp)
	`, 100)
	if v != Int(42) {
		t.Fatalf("add1 tmp = %v; want 42", v)
	}
}
