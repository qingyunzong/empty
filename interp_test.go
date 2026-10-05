package interp

import (
	"reflect"
	"strings"
	"testing"
)

const bigBudget = int64(1) << 40

func parse(t *testing.T, src string) []*Node {
	t.Helper()
	prog, err := Parse(src)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return prog
}

func runMachine(t *testing.T, src string) *Machine {
	t.Helper()
	m := NewMachine(parse(t, src), NewGlobals())
	if st := m.Run(bigBudget); st != StatusDone {
		t.Fatalf("machine status=%v err=%q", st, m.Err)
	}
	return m
}

func runRef(t *testing.T, src string) (*Ref, Value) {
	t.Helper()
	r := &Ref{}
	v, err := r.Run(parse(t, src), NewGlobals())
	if err != nil {
		t.Fatalf("ref: %v", err)
	}
	return r, v
}

// crossCheck runs src on both interpreters and requires identical values and logs.
func crossCheck(t *testing.T, src string) (Value, []string) {
	t.Helper()
	m := runMachine(t, src)
	r, rv := runRef(t, src)
	if showValue(m.Val) != showValue(rv) {
		t.Fatalf("value mismatch: machine=%s ref=%s", showValue(m.Val), showValue(rv))
	}
	if !reflect.DeepEqual(m.Out, r.Out) {
		t.Fatalf("log mismatch:\nmachine=%q\nref=%q", m.Out, r.Out)
	}
	return rv, r.Out
}

func TestClosuresAndLexicalScope(t *testing.T) {
	v, _ := crossCheck(t, `
(define (make-counter)
  (let ((n 0))
    (lambda () (set! n (+ n 1)) n)))
(define c1 (make-counter))
(define c2 (make-counter))
(c1)
(c1)
(c2)
(emit (c1) (c2))
(c1)`)
	if showValue(v) != "4" {
		t.Fatalf("got %s", showValue(v))
	}
}

func TestRecursion(t *testing.T) {
	v, _ := crossCheck(t, `
(define (fact n) (if (= n 0) 1 (* n (fact (- n 1)))))
(fact 10)`)
	if showValue(v) != "3628800" {
		t.Fatalf("got %s", showValue(v))
	}
}

func TestLetLambdaPairs(t *testing.T) {
	_, out := crossCheck(t, `
(define xs (quote (1 2 3)))
(emit xs)
(emit (car xs) (car (cdr xs)) (car (cdr (cdr xs))))
(emit (cons 0 xs))
(emit (nil? (quote ())) (pair? xs))
(let ((x 10) (y 20)) (emit (+ x y)))
(emit (list 1 "two" true))`)
	want := []string{"(1 2 3)", "1 2 3", "(0 1 2 3)", "true true", "30", "(1 two true)"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %q want %q", out, want)
	}
}

func TestTailCallEliminationBoundedStack(t *testing.T) {
	src := `
(define (loop n acc)
  (if (= n 0) acc (loop (- n 1) (+ acc 1))))
(loop 200000 0)`
	m := runMachine(t, src)
	if showValue(m.Val) != "200000" {
		t.Fatalf("got %s", showValue(m.Val))
	}
	if m.MaxStack > 64 {
		t.Fatalf("tail call not eliminated: max stack %d", m.MaxStack)
	}
	// Same program on the reference interpreter (smaller depth: it uses Go stack).
	src2 := `
(define (loop n acc)
  (if (= n 0) acc (loop (- n 1) (+ acc 1))))
(loop 20000 0)`
	r, rv := runRef(t, src2)
	if showValue(rv) != "20000" {
		t.Fatalf("ref got %s", showValue(rv))
	}
	if r.MaxDepth < 20000 {
		t.Fatalf("reference should not eliminate tail calls: max depth %d", r.MaxDepth)
	}
}

func TestFinallyPreventsTailCallElimination(t *testing.T) {
	src := `
(define (loop n)
  (try
    (if (= n 0) "done" (loop (- n 1)))
    (finally (emit n))))
(loop 1000)`
	m := runMachine(t, src)
	if showValue(m.Val) != "done" {
		t.Fatalf("got %s", showValue(m.Val))
	}
	if m.MaxStack < 1000 {
		t.Fatalf("pending finally should prevent stack elimination: max stack %d", m.MaxStack)
	}
	// Cleanups run innermost-first as the recursion unwinds: 0,1,...,1000.
	r, rv := runRef(t, src)
	if showValue(rv) != "done" {
		t.Fatalf("ref got %s", showValue(rv))
	}
	if !reflect.DeepEqual(m.Out, r.Out) {
		t.Fatalf("cleanup log mismatch:\nmachine=%q\nref=%q", m.Out, r.Out)
	}
	if len(m.Out) != 1001 || m.Out[0] != "0" || m.Out[1000] != "1000" {
		t.Fatalf("unexpected cleanup log: len=%d first=%q last=%q", len(m.Out), m.Out[0], m.Out[len(m.Out)-1])
	}
}

func TestExceptionOrderCatchThenFinally(t *testing.T) {
	_, out := crossCheck(t, `
(try
  (try
    (throw "boom")
    (finally (emit "inner-finally")))
  (catch (e) (emit "caught" e) "handled")
  (finally (emit "outer-finally")))`)
	want := []string{"inner-finally", "caught boom", "outer-finally"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %q want %q", out, want)
	}
}

func TestCatchValue(t *testing.T) {
	v, _ := crossCheck(t, `(+ 1 (try (throw 41) (catch (e) e)))`)
	if showValue(v) != "42" {
		t.Fatalf("got %s", showValue(v))
	}
}

func TestThrowThroughMultipleFinally(t *testing.T) {
	_, out := crossCheck(t, `
(define (f n)
  (try
    (if (= n 0) (throw "deep") (f (- n 1)))
    (finally (emit "cleanup" n))))
(try (f 3) (catch (e) (emit "got" e) "caught"))`)
	want := []string{"cleanup 0", "cleanup 1", "cleanup 2", "cleanup 3", "got deep"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %q want %q", out, want)
	}
}

func TestUncaughtExceptionStillRunsFinally(t *testing.T) {
	src := `(try (throw "boom") (finally (emit "cleanup")))`
	prog := parse(t, src)
	m := NewMachine(prog, NewGlobals())
	if st := m.Run(bigBudget); st != StatusFailed {
		t.Fatalf("machine status=%v", st)
	}
	if m.Err != "uncaught exception: boom" {
		t.Fatalf("machine err=%q", m.Err)
	}
	r := &Ref{}
	_, err := r.Run(prog, NewGlobals())
	if err == nil || err.Error() != m.Err {
		t.Fatalf("ref err=%v", err)
	}
	if !reflect.DeepEqual(m.Out, r.Out) || !reflect.DeepEqual(m.Out, []string{"cleanup"}) {
		t.Fatalf("logs: machine=%q ref=%q", m.Out, r.Out)
	}
}

func TestThrowInsideFinallyAndCatch(t *testing.T) {
	// A throw from a catch handler still triggers the finally cleanup, and a
	// throw from a finally supersedes the original exception.
	_, out := crossCheck(t, `
(try
  (try
    (try (throw "first") (catch (e) (emit "h1" e) (throw "second")) (finally (emit "f1")))
    (catch (e) (emit "h2" e) "ok"))
  (finally (emit "f2")))`)
	want := []string{"h1 first", "f1", "h2 second", "f2"}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %q want %q", out, want)
	}
}

func TestBudgetExhaustionPreservesState(t *testing.T) {
	src := `
(define (countdown n)
  (if (= n 0) "done" (begin (emit n) (countdown (- n 1)))))
(countdown 100)`
	prog := parse(t, src)

	// Reference run for the expected value and log.
	r, rv := runRef(t, src)

	// Chopped run: tiny budgets, state must be preserved across suspensions.
	m := NewMachine(prog, NewGlobals())
	suspensions := 0
	for {
		st := m.Run(13)
		if st == StatusDone {
			break
		}
		if st == StatusFailed {
			t.Fatalf("err=%q", m.Err)
		}
		suspensions++
		if suspensions > 100000 {
			t.Fatal("no progress")
		}
	}
	if suspensions == 0 {
		t.Fatal("expected at least one suspension")
	}
	if showValue(m.Val) != showValue(rv) {
		t.Fatalf("value mismatch: %s vs %s", showValue(m.Val), showValue(rv))
	}
	if !reflect.DeepEqual(m.Out, r.Out) {
		t.Fatalf("log mismatch:\nchopped=%q\nref=%q", m.Out, r.Out)
	}

	// A single big-budget run must agree with the chopped run.
	m2 := runMachine(t, src)
	if !reflect.DeepEqual(m.Out, m2.Out) || showValue(m.Val) != showValue(m2.Val) {
		t.Fatal("chopped run disagrees with uninterrupted run")
	}
}

func TestSerializableContinuation(t *testing.T) {
	programs := []string{
		// Tail-recursive loop with emissions (closure captures global env: cyclic).
		`
(define (countdown n)
  (if (= n 0) "done" (begin (emit n) (countdown (- n 1)))))
(countdown 60)`,
		// Pending finally frames on the stack while suspending/resuming.
		`
(define (loop n)
  (try
    (if (= n 0) "done" (loop (- n 1)))
    (finally (emit n))))
(loop 40)`,
		// Exception unwinding with finally cleanups and a catch.
		`
(define (f n)
  (try
    (if (= n 0) (throw "deep") (f (- n 1)))
    (finally (emit "cleanup" n))))
(try (f 20) (catch (e) (emit "got" e) "caught"))`,
	}
	for i, src := range programs {
		t.Run(strings.TrimSpace(strings.Split(src, "\n")[1]), func(t *testing.T) {
			prog := parse(t, src)
			r, rv := runRef(t, src)

			m := NewMachine(prog, NewGlobals())
			restores := 0
			for {
				st := m.Run(7)
				if st == StatusDone {
					break
				}
				if st == StatusFailed {
					t.Fatalf("err=%q", m.Err)
				}
				data, err := m.Snapshot()
				if err != nil {
					t.Fatalf("snapshot: %v", err)
				}
				m, err = Restore(data)
				if err != nil {
					t.Fatalf("restore: %v", err)
				}
				restores++
				if restores > 1000000 {
					t.Fatal("no progress")
				}
			}
			if restores == 0 {
				t.Fatal("expected at least one snapshot/restore")
			}
			if showValue(m.Val) != showValue(rv) {
				t.Fatalf("program %d: value mismatch: %s vs %s", i, showValue(m.Val), showValue(rv))
			}
			if !reflect.DeepEqual(m.Out, r.Out) {
				t.Fatalf("program %d: log mismatch:\nrestored=%q\nref=%q", i, m.Out, r.Out)
			}
		})
	}
}

func TestSnapshotMidProgramIsUsable(t *testing.T) {
	// Suspend after a bounded number of steps, snapshot, and resume on a
	// different machine instance; both value and log must match the reference.
	src := `
(define (make-adder k) (lambda (x) (+ x k)))
(define add5 (make-adder 5))
(define (work n acc)
  (try
    (if (= n 0) acc (work (- n 1) (add5 acc)))
    (finally (emit "step" n))))
(work 30 0)`
	prog := parse(t, src)
	r, rv := runRef(t, src)

	m := NewMachine(prog, NewGlobals())
	for i := 0; i < 50; i++ {
		if st := m.Run(11); st != StatusSuspended {
			t.Fatalf("expected suspension, got %v", st)
		}
		data, err := m.Snapshot()
		if err != nil {
			t.Fatalf("snapshot: %v", err)
		}
		m, err = Restore(data)
		if err != nil {
			t.Fatalf("restore: %v", err)
		}
	}
	if st := m.Run(bigBudget); st != StatusDone {
		t.Fatalf("status=%v err=%q", st, m.Err)
	}
	if showValue(m.Val) != showValue(rv) {
		t.Fatalf("value mismatch: %s vs %s", showValue(m.Val), showValue(rv))
	}
	if !reflect.DeepEqual(m.Out, r.Out) {
		t.Fatalf("log mismatch:\nrestored=%q\nref=%q", m.Out, r.Out)
	}
}

func TestRuntimeErrors(t *testing.T) {
	for _, src := range []string{
		`(car 5)`,
		`undefined-variable`,
		`((lambda (x) x) 1 2)`,
	} {
		m := NewMachine(parse(t, src), NewGlobals())
		if st := m.Run(bigBudget); st != StatusFailed {
			t.Fatalf("%s: machine status=%v", src, st)
		}
		r := &Ref{}
		if _, err := r.Run(parse(t, src), NewGlobals()); err == nil {
			t.Fatalf("%s: ref should fail", src)
		}
	}
}
