package interp

import (
	"encoding/json"
	"reflect"
	"testing"
)

func mustParse(t *testing.T, src string) *Node {
	t.Helper()
	n, err := Parse(src)
	if err != nil {
		t.Fatalf("parse %q: %v", src, err)
	}
	return n
}

type outcome struct {
	result string   // Show(result), empty unless Done
	err    string   // machine Err / reference error, empty on success
	log    []string // cleanup/output log
}

// runMachine evaluates prog, resuming in chunks of `chunk` steps whenever
// the budget runs out. If roundTrip is set, the whole machine state is
// serialized to JSON and restored at every suspension.
func runMachine(t *testing.T, prog *Node, chunk int64, roundTrip bool) outcome {
	t.Helper()
	m := NewMachine(prog, chunk)
	for i := 0; ; i++ {
		if i > 2_000_000 {
			t.Fatal("machine did not terminate")
		}
		m.Run()
		if m.Status != Suspended {
			break
		}
		if roundTrip {
			data, err := json.Marshal(m)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			nm := &Machine{}
			if err := json.Unmarshal(data, nm); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			m = nm
		}
		m.Resume(chunk)
	}
	o := outcome{err: m.Err, log: m.Log}
	if m.Status == Done {
		o.result = Show(m.Result)
	}
	return o
}

func runRef(t *testing.T, prog *Node) outcome {
	t.Helper()
	r := &Ref{}
	v, err := r.Eval(prog)
	o := outcome{log: r.Log}
	if err != nil {
		o.err = err.Error()
	} else {
		o.result = Show(v)
	}
	return o
}

// crossCheck runs the program on the machine (uninterrupted, chunked, and
// serialized-chunked) and on the reference interpreter, requiring identical
// values and cleanup logs everywhere.
func crossCheck(t *testing.T, src string) {
	t.Helper()
	prog := mustParse(t, src)
	want := runRef(t, prog)
	for _, tc := range []struct {
		name      string
		chunk     int64
		roundTrip bool
	}{
		{"uninterrupted", 1 << 40, false},
		{"chunked", 7, false},
		{"serialized", 7, true},
	} {
		got := runMachine(t, prog, tc.chunk, tc.roundTrip)
		if got.result != want.result || got.err != want.err {
			t.Errorf("%s: machine=(%q, %q) reference=(%q, %q)",
				tc.name, got.result, got.err, want.result, want.err)
		}
		if !reflect.DeepEqual(got.log, want.log) {
			t.Errorf("%s: log mismatch\nmachine:   %v\nreference: %v",
				tc.name, got.log, want.log)
		}
	}
}

func TestClosures(t *testing.T) {
	crossCheck(t, `
(let ((add (lambda (x) (lambda (y) (+ x y)))))
  (let ((add3 (add 3)))
    (+ (add3 4) (add3 10))))`)
	// Shadowing and nested captures.
	crossCheck(t, `
(let ((x 1))
  (let ((f (lambda (y) (+ x y))))
    (let ((x 100))
      (f 5))))`)
}

func TestRecursion(t *testing.T) {
	crossCheck(t, `
(letrec ((fact (lambda (n) (if (= n 0) 1 (* n (fact (- n 1)))))))
  (fact 10))`)
	crossCheck(t, `
(letrec ((fib (lambda (n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))))
  (fib 12))`)
	// Mutual recursion via letrec-bound closures.
	crossCheck(t, `
(letrec ((even? (lambda (n) (if (= n 0) true (odd? (- n 1)))))
         (odd?  (lambda (n) (if (= n 0) false (even? (- n 1))))))
  (odd? 7))`)
}

func TestExceptionsAndFinally(t *testing.T) {
	// Finally runs on the normal path, after the body.
	crossCheck(t, `(try (begin (log "body") 7) (finally (log "fin")))`)
	// Throw caught; finally of the inner try runs during unwind.
	crossCheck(t, `
(try
  (try (throw "boom") (finally (log "inner-fin")))
  (catch (e) (log "caught" e) 42))`)
	// Cleanup ordering: innermost finally first.
	crossCheck(t, `
(letrec ((f (lambda (n)
              (if (= n 0)
                  (throw "boom")
                  (try (f (- n 1)) (finally (log "fin" n)))))))
  (try (f 3) (catch (e) (log "caught" e) 42)))`)
	// An exception thrown by a cleanup replaces the in-flight outcome.
	crossCheck(t, `(try (try 1 (finally (throw "x"))) (catch (e) e))`)
	// An exception thrown by a handler still triggers the outer finally.
	crossCheck(t, `
(try
  (try (throw "a") (catch (e) (throw "b")))
  (finally (log "outer-fin")))`)
	// Primitive errors are catchable exceptions.
	crossCheck(t, `(try (/ 1 0) (catch (e) (log "err" e) 42))`)
	// Unbound variables raise catchable exceptions.
	crossCheck(t, `(try nosuchvar (catch (e) e))`)
	// Uncaught exception: machine fails, reference errors identically.
	crossCheck(t, `(throw "oops")`)
	// Finally value is discarded; body value is returned.
	crossCheck(t, `(try 5 (finally 99))`)
}

func TestTailCallElimination(t *testing.T) {
	prog := mustParse(t, `
(letrec ((loop (lambda (n acc)
                 (if (= n 0) acc (loop (- n 1) (+ acc 1))))))
  (loop 100000 0))`)
	m := NewMachine(prog, 1<<40)
	m.Run()
	if m.Status != Done || Show(m.Result) != "100000" {
		t.Fatalf("got status=%v result=%q err=%q", m.Status, Show(m.Result), m.Err)
	}
	if m.MaxDepth > 50 {
		t.Errorf("tail calls were not eliminated: MaxDepth=%d", m.MaxDepth)
	}
}

func TestNonTailRecursionGrowsStack(t *testing.T) {
	prog := mustParse(t, `
(letrec ((s (lambda (n) (if (= n 0) 0 (+ n (s (- n 1)))))))
  (s 500))`)
	m := NewMachine(prog, 1<<40)
	m.Run()
	if m.Status != Done || Show(m.Result) != "125250" {
		t.Fatalf("got status=%v result=%q err=%q", m.Status, Show(m.Result), m.Err)
	}
	if m.MaxDepth < 1000 {
		t.Errorf("expected stack growth for non-tail recursion, MaxDepth=%d", m.MaxDepth)
	}
	// Same value from the reference interpreter.
	if got := runRef(t, prog); got.result != "125250" {
		t.Errorf("reference result %q", got.result)
	}
}

func TestTailCallBlockedByFinally(t *testing.T) {
	// The recursive call sits in tail position syntactically, but the
	// pending finally must observe its return, so the frame cannot be
	// eliminated: stack depth must grow with the recursion depth.
	src := `
(letrec ((loop (lambda (n)
                 (if (= n 0)
                     (log "done")
                     (try (loop (- n 1)) (finally (log "fin")))))))
  (loop 60))`
	prog := mustParse(t, src)
	m := NewMachine(prog, 1<<40)
	m.Run()
	if m.Status != Done {
		t.Fatalf("status=%v err=%q", m.Status, m.Err)
	}
	if m.MaxDepth < 100 {
		t.Errorf("finally did not block tail-call elimination: MaxDepth=%d", m.MaxDepth)
	}
	want := runRef(t, prog)
	if !reflect.DeepEqual(m.Log, want.log) {
		t.Errorf("log mismatch\nmachine:   %v\nreference: %v", m.Log, want.log)
	}
	// Sanity: cleanup ran once per level, innermost first.
	if len(m.Log) != 61 || m.Log[0] != "done" || m.Log[1] != "fin" || m.Log[60] != "fin" {
		t.Errorf("unexpected log: %v...", m.Log[:3])
	}
}

func TestStepBudgetExhaustionPreservesState(t *testing.T) {
	prog := mustParse(t, `
(letrec ((f (lambda (n)
              (if (= n 0)
                  (throw "boom")
                  (try (f (- n 1)) (finally (log "fin" n)))))))
  (try (f 3) (catch (e) (log "caught" e) 42)))`)
	full := runMachine(t, prog, 1<<40, false)
	for _, chunk := range []int64{1, 2, 3, 5, 17} {
		got := runMachine(t, prog, chunk, false)
		if got.result != full.result || got.err != full.err || !reflect.DeepEqual(got.log, full.log) {
			t.Errorf("chunk=%d: got %+v want %+v", chunk, got, full)
		}
	}
}

func TestSerializableContinuation(t *testing.T) {
	// Round-trip the machine through JSON after every single step of a
	// program that exercises closures, recursion, throw, catch, finally.
	prog := mustParse(t, `
(begin
  (log "start")
  (letrec ((f (lambda (n)
                (if (= n 0)
                    (throw "boom")
                    (try (f (- n 1)) (finally (log "fin" n)))))))
    (try (f 4) (catch (e) (log "caught" e) (+ 40 2)))))`)
	want := runMachine(t, prog, 1<<40, false)
	got := runMachine(t, prog, 1, true)
	if got.result != want.result || got.err != want.err || !reflect.DeepEqual(got.log, want.log) {
		t.Errorf("serialized run %+v, want %+v", got, want)
	}
	if want.result != "42" {
		t.Errorf("unexpected result %q", want.result)
	}
	wantLog := []string{"start", "fin 1", "fin 2", "fin 3", "fin 4", "caught boom"}
	if !reflect.DeepEqual(got.log, wantLog) {
		t.Errorf("log %v, want %v", got.log, wantLog)
	}
}

func TestSerializedClosureKeepsRecursion(t *testing.T) {
	// Suspend inside a recursive call, serialize, and verify the restored
	// closure can still call itself (env<->closure cycle survives).
	prog := mustParse(t, `
(letrec ((fact (lambda (n) (if (= n 0) 1 (* n (fact (- n 1)))))))
  (fact 10))`)
	m := NewMachine(prog, 50)
	m.Run()
	if m.Status != Suspended {
		t.Fatalf("expected suspension, got %v", m.Status)
	}
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	nm := &Machine{}
	if err := json.Unmarshal(data, nm); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	nm.Resume(1 << 40)
	if nm.Status != Done || Show(nm.Result) != "3628800" {
		t.Fatalf("got status=%v result=%q err=%q", nm.Status, Show(nm.Result), nm.Err)
	}
}

func TestCrossCheckPrograms(t *testing.T) {
	programs := []string{
		`(+ 1 (* 2 3))`,
		`(if (< 1 2) "yes" "no")`,
		`(begin (log "a") (log "b" 1) 9)`,
		`(let ((x 3) (y 4)) (+ (* x x) (* y y)))`,
		`((lambda (f) (f (f 3))) (lambda (x) (* x 2)))`,
		`(try (begin (throw 7) (log "unreachable")) (catch (e) (+ e 1)))`,
		`(try 1 (catch (e) 2) (finally (log "fin")))`,
		`(not (= 1 2))`,
		`(try (+ 1 "x") (catch (e) "type-error"))`,
		`(letrec ((map2 (lambda (f n)
		                  (if (= n 0) 0 (+ (f n) (map2 f (- n 1)))))))
		   (map2 (lambda (x) (* x x)) 5))`,
	}
	for _, src := range programs {
		crossCheck(t, src)
	}
}
