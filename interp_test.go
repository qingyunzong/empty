package macro

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func run(t *testing.T, src string, budget int) (Value, *Interpreter, error) {
	t.Helper()
	in := NewInterpreter(budget)
	v, err := in.Run(src)
	return v, in, err
}

// TestHandWrittenScopeModel evaluates small programs whose results were
// derived by hand from the lexical scope model:
//   - each let/lambda/call opens one frame chained to its definition env;
//   - lookup walks the chain from innermost to outermost;
//   - closures capture the env where the lambda was evaluated, not the
//     caller's env.
func TestHandWrittenScopeModel(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want Value
	}{
		{
			// global frame: x -> 5; lookup hits the global frame.
			"global lookup",
			`(define x 5) x`,
			Int(5),
		},
		{
			// call frame: x -> 9 shadows global x -> 1.
			"lambda param shadows global",
			`(define x 1) (define f (lambda (x) x)) (f 9)`,
			Int(9),
		},
		{
			// let frame: x -> 2 shadows global x -> 1.
			"let shadows global",
			`(define x 1) (let ((x 2)) x)`,
			Int(2),
		},
		{
			// parallel let: both initializers evaluate in the outer frame,
			// so y sees the outer x -> 1, not the new x -> 2.
			"let initializers see outer env",
			`(define x 1) (let ((x 2) (y x)) y)`,
			Int(1),
		},
		{
			// inner let frame x -> 2 shadows outer let frame x -> 1.
			"nested let shadows",
			`(let ((x 1)) (let ((x 2)) x))`,
			Int(2),
		},
		{
			// the lambda is created inside (let ((x 10)) ...), so its
			// captured env has x -> 10; the caller's x -> 100 is invisible.
			"closure captures definition env",
			`(define x 1)
			 (define f (let ((x 10)) (lambda () x)))
			 (let ((x 100)) (f))`,
			Int(10),
		},
		{
			// define inside a let body lands in the let frame:
			// let frame: x -> 2, then y -> 3; body sees both.
			"local define in let body",
			`(let ((x 2)) (begin (define y 3) (+ x y)))`,
			Int(5),
		},
		{
			// recursion: fact(5) = 5*4*3*2*1*1 = 120, each call one frame.
			"recursive closure",
			`(define fact (lambda (n) (if (= n 0) 1 (* n (fact (- n 1))))))
			 (fact 5)`,
			Int(120),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v, _, err := run(t, tc.src, 100000)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(v, tc.want) {
				t.Fatalf("got %s, want %s", String(v.(Expr)), String(tc.want.(Expr)))
			}
		})
	}
}

// TestEnvModelByHand builds the scope chain by hand and checks resolution.
func TestEnvModelByHand(t *testing.T) {
	global := NewEnv(nil)
	global.Define("x", Int(1))
	global.Define("z", Int(3))

	inner := NewEnv(global)
	inner.Define("x", Int(2))

	if v, ok := inner.Lookup("x"); !ok || v != Int(2) {
		t.Fatalf("inner x: got %v, %v; want 2, true", v, ok)
	}
	if v, ok := global.Lookup("x"); !ok || v != Int(1) {
		t.Fatalf("global x: got %v, %v; want 1, true", v, ok)
	}
	if v, ok := inner.Lookup("z"); !ok || v != Int(3) {
		t.Fatalf("inner z (via parent): got %v, %v; want 3, true", v, ok)
	}
	if _, ok := inner.Lookup("missing"); ok {
		t.Fatalf("missing must not resolve")
	}
}

// TestArgsEvaluatedInCallerEnv: actual arguments are evaluated in the call
// environment before expansion.
func TestArgsEvaluatedInCallerEnv(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want Value
	}{
		{
			// a at the call site is the let-bound 2, so v := 2.
			"caller local is the argument value",
			`(define a 1)
			 (defmacro id (v) v)
			 (let ((a 2)) (id a))`,
			Int(2),
		},
		{
			// argument expression (+ a 1) is computed at the call site: 21.
			"argument expression computed at call site",
			`(defmacro dbl (v) (+ v v))
			 (let ((a 10)) (dbl (+ a 1)))`,
			Int(22),
		},
		{
			// the template's own let-bound a#N cannot interfere: the
			// argument was already reduced to the literal 2 beforehand.
			"argument value immune to template binders",
			`(defmacro m (v) (let ((a 100)) v))
			 (let ((a 2)) (m a))`,
			Int(2),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v, _, err := run(t, tc.src, 100000)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(v, tc.want) {
				t.Fatalf("got %s, want %s", String(v.(Expr)), String(tc.want.(Expr)))
			}
		})
	}
}

// TestExpansionDoesNotCaptureCallerLocals: expansions are evaluated in the
// macro's definition environment and template binders are renamed, so a
// caller local with the same name is never captured.
func TestExpansionDoesNotCaptureCallerLocals(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want Value
	}{
		{
			// getx expands to the free symbol x; the expansion runs in the
			// definition env where x -> 1, so the caller's x -> 42 is NOT
			// captured. Hand model: result is 1, not 42.
			"template free symbol resolves at definition site",
			`(define x 1)
			 (defmacro getx () x)
			 (let ((x 42)) (getx))`,
			Int(1),
		},
		{
			// expansion: (let ((t#1 1)) (+ t#1 7)) — the introduced binder
			// is renamed, so it cannot capture the caller's t -> 7, and the
			// argument 7 was fixed at the call site. Result: 1 + 7 = 8.
			"introduced binder renamed, caller local untouched",
			`(define t 100)
			 (defmacro m (v) (let ((t 1)) (+ t v)))
			 (let ((t 7)) (m t))`,
			Int(8),
		},
		{
			// nested macros: inner expansion (free x) is not captured by
			// the outer macro's introduced let-binder x#N.
			"nested macro free symbol not captured",
			`(define x 5)
			 (defmacro inner () x)
			 (defmacro outer () (let ((x 1)) (inner)))
			 (outer)`,
			Int(5),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v, _, err := run(t, tc.src, 100000)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(v, tc.want) {
				t.Fatalf("got %s, want %s", String(v.(Expr)), String(tc.want.(Expr)))
			}
		})
	}
}

// TestHygienicRenamingStructure inspects the raw expansion: every binder the
// template introduces must be renamed to a fresh gensym name.
func TestHygienicRenamingStructure(t *testing.T) {
	in := NewInterpreter(1000)
	env := in.GlobalEnv()
	if _, err := in.Eval(List{
		Symbol("defmacro"), Symbol("m"), List{Symbol("a")},
		List{Symbol("let"),
			List{List{Symbol("tmp"), Symbol("a")}},
			List{Symbol("+"), Symbol("tmp"), Symbol("a")}},
	}, env); err != nil {
		t.Fatalf("defmacro: %v", err)
	}
	mv, ok := env.Lookup("m")
	if !ok {
		t.Fatal("macro m not defined")
	}
	exp, err := in.expand(mv.(*Macro), []Value{Int(7)})
	if err != nil {
		t.Fatalf("expand: %v", err)
	}
	got := String(exp)
	want := "(let ((tmp#1 7)) (+ tmp#1 7))"
	if got != want {
		t.Fatalf("expansion = %s, want %s", got, want)
	}
}

// TestRecursiveExpansionChain: recursive macro expansion records the full
// call chain in order.
func TestRecursiveExpansionChain(t *testing.T) {
	t.Run("self recursion", func(t *testing.T) {
		v, in, err := run(t, `
			(defmacro rec (n) (if (= n 0) 0 (rec (- n 1))))
			(rec 3)`, 100000)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if v != Int(0) {
			t.Fatalf("got %v, want 0", v)
		}
		want := []string{"rec", "rec", "rec", "rec"} // rec(3) rec(2) rec(1) rec(0)
		if !reflect.DeepEqual(in.Trace(), want) {
			t.Fatalf("trace = %v, want %v", in.Trace(), want)
		}
	})
	t.Run("mutual recursion", func(t *testing.T) {
		v, in, err := run(t, `
			(defmacro ea (n) (if (= n 0) 0 (eb (- n 1))))
			(defmacro eb (n) (if (= n 0) 1 (ea (- n 1))))
			(ea 4)`, 100000)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if v != Int(0) {
			t.Fatalf("got %v, want 0", v)
		}
		want := []string{"ea", "eb", "ea", "eb", "ea"} // ea(4) eb(3) ea(2) eb(1) ea(0)
		if !reflect.DeepEqual(in.Trace(), want) {
			t.Fatalf("trace = %v, want %v", in.Trace(), want)
		}
	})
}

// TestStepBudget: when the step budget runs out, the interpreter reports an
// unclosed expansion together with the active macro call chain.
func TestStepBudget(t *testing.T) {
	t.Run("infinite macro recursion exhausts budget", func(t *testing.T) {
		_, _, err := run(t, `
			(defmacro loop (n) (loop n))
			(loop 1)`, 500)
		var berr *BudgetExceededError
		if !errors.As(err, &berr) {
			t.Fatalf("err = %v, want BudgetExceededError", err)
		}
		msg := err.Error()
		if !strings.Contains(msg, "budget") || !strings.Contains(msg, "unclosed") {
			t.Fatalf("error message %q must mention budget and unclosed", msg)
		}
		if len(berr.Chain) == 0 {
			t.Fatal("chain must not be empty")
		}
		for _, name := range berr.Chain {
			if name != "loop" {
				t.Fatalf("chain contains %q, want only loop", name)
			}
		}
	})
	t.Run("same program closes with sufficient budget", func(t *testing.T) {
		src := `
			(defmacro rec (n) (if (= n 0) 0 (rec (- n 1))))
			(rec 30)`
		if _, _, err := run(t, src, 10); err == nil {
			t.Fatal("budget 10: want error, got nil")
		} else {
			var berr *BudgetExceededError
			if !errors.As(err, &berr) {
				t.Fatalf("budget 10: err = %v, want BudgetExceededError", err)
			}
		}
		v, _, err := run(t, src, 100000)
		if err != nil {
			t.Fatalf("budget 100000: unexpected error: %v", err)
		}
		if v != Int(0) {
			t.Fatalf("got %v, want 0", v)
		}
	})
}
