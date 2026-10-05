package debuglib

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

func assign(line int, name, src string) *Assign {
	e, err := ParseExpr(src)
	if err != nil {
		panic(err)
	}
	return &Assign{Ln: line, Name: name, Value: e}
}

func printStmt(line int, src string) *Print {
	e, err := ParseExpr(src)
	if err != nil {
		panic(err)
	}
	return &Print{Ln: line, Value: e}
}

// Conditions are evaluated before the statement at their line executes.
func TestConditionEvaluatedBeforeStatement(t *testing.T) {
	prog := &Program{Stmts: []Stmt{
		assign(1, "x", "1"),
		assign(2, "x", "2"),
		printStmt(3, "x"),
	}}
	d := NewDebugger(prog)
	if err := d.AddBreakpoint(2, 1, "x == 1"); err != nil {
		t.Fatal(err)
	}
	reason, err := d.Continue()
	if err != nil || reason != AtBreakpoint {
		t.Fatalf("got %v, %v; want AtBreakpoint", reason, err)
	}
	st := d.Snapshot()
	if st.Env["x"] != 1 || st.PC != 1 {
		t.Fatalf("statement executed before stop: %+v", st)
	}
	// Step executes exactly the pending statement.
	reason, err = d.Step()
	if err != nil || reason != AtStatement {
		t.Fatalf("got %v, %v; want AtStatement", reason, err)
	}
	if st := d.Snapshot(); st.Env["x"] != 2 || st.PC != 2 {
		t.Fatalf("step did not execute exactly one statement: %+v", st)
	}
}

// A failing condition stops execution and preserves the state exactly.
func TestConditionErrorStopsAndPreservesState(t *testing.T) {
	prog := &Program{Stmts: []Stmt{
		assign(1, "x", "1"),
		assign(2, "x", "5"),
		printStmt(3, "x"),
	}}
	d := NewDebugger(prog)
	if err := d.AddBreakpoint(2, 7, "nope > 0"); err != nil { // undefined variable
		t.Fatal(err)
	}
	if _, err := d.Step(); err != nil { // execute line 1; x is now 1
		t.Fatal(err)
	}
	before := d.Snapshot()
	reason, err := d.Continue()
	if reason != ConditionError {
		t.Fatalf("got %v, %v; want ConditionError", reason, err)
	}
	var ce *CondError
	if !errors.As(err, &ce) || ce.Line != 2 || ce.ID != 7 {
		t.Fatalf("unexpected error: %v", err)
	}
	after := d.Snapshot()
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("state changed on condition error:\nbefore %+v\nafter  %+v", before, after)
	}
	// Removing the offending breakpoint lets the program finish normally.
	if !d.RemoveBreakpoint(2, 7) {
		t.Fatal("RemoveBreakpoint reported false")
	}
	reason, err = d.Continue()
	if reason != Finished || err != nil {
		t.Fatalf("got %v, %v; want Finished", reason, err)
	}
	want, _ := Run(prog)
	if got := d.Snapshot(); !reflect.DeepEqual(got, *want) {
		t.Fatalf("got %+v; want %+v", got, *want)
	}
}

// At one line, conditions are evaluated in ascending breakpoint ID order:
// the first true condition hits, the first error stops, whichever comes
// first by ID.
func TestMultipleConditionsOrderedByID(t *testing.T) {
	prog := &Program{Stmts: []Stmt{
		assign(1, "x", "1"),
		assign(2, "x", "2"),
	}}

	// ID 1 (true) sorts before ID 2 (error): hit wins, error never evaluated.
	d := NewDebugger(prog)
	if err := d.AddBreakpoint(1, 2, "nope > 0"); err != nil {
		t.Fatal(err)
	}
	if err := d.AddBreakpoint(1, 1, "0 == 1"); err != nil { // false
		t.Fatal(err)
	}
	if err := d.AddBreakpoint(1, 3, "1 == 1"); err != nil { // true, but after error
		t.Fatal(err)
	}
	reason, err := d.Continue()
	if reason != ConditionError {
		t.Fatalf("got %v, %v; want ConditionError (ID 2 evaluated before ID 3)", reason, err)
	}
	var ce *CondError
	if !errors.As(err, &ce) || ce.ID != 2 {
		t.Fatalf("want error from breakpoint ID 2, got %v", err)
	}

	// Replace the erroring condition with a true one at a lower ID: now the
	// hit at ID 2 wins and ID 3 is never reached.
	if !d.RemoveBreakpoint(1, 2) {
		t.Fatal("RemoveBreakpoint reported false")
	}
	if err := d.AddBreakpoint(1, 2, "0 == 1"); err != nil { // false
		t.Fatal(err)
	}
	reason, err = d.Continue()
	if reason != AtBreakpoint || err != nil {
		t.Fatalf("got %v, %v; want AtBreakpoint (true condition at ID 3)", reason, err)
	}
	if pc := d.Snapshot().PC; pc != 0 {
		t.Fatalf("hit before first statement, want PC 0, got %d", pc)
	}
}

// Step has deterministic semantics: exactly one statement per call,
// breakpoints (even erroring ones) are ignored.
func TestStepIgnoresBreakpoints(t *testing.T) {
	prog := &Program{Stmts: []Stmt{
		assign(1, "x", "10"),
		assign(2, "x", "x + 1"),
		printStmt(3, "x"),
	}}
	d := NewDebugger(prog)
	if err := d.AddBreakpoint(1, 1, "boom == 1"); err != nil { // would error if evaluated
		t.Fatal(err)
	}
	for i, want := range []StopReason{AtStatement, AtStatement, Finished} {
		reason, err := d.Step()
		if reason != want || err != nil {
			t.Fatalf("step %d: got %v, %v; want %v", i, reason, err, want)
		}
	}
	st := d.Snapshot()
	if st.Env["x"] != 11 || !reflect.DeepEqual(st.Out, []int64{11}) {
		t.Fatalf("unexpected final state: %+v", st)
	}
}

// Continue after a hit always makes progress: the breakpoint at the current
// PC is not re-checked by the immediately following Continue.
func TestContinueMakesProgressAfterHit(t *testing.T) {
	prog := &Program{Stmts: []Stmt{
		assign(1, "x", "1"),
		assign(2, "x", "2"),
		assign(3, "x", "3"),
	}}
	d := NewDebugger(prog)
	for line := 1; line <= 3; line++ {
		if err := d.AddBreakpoint(line, 1, "1 == 1"); err != nil { // always true
			t.Fatal(err)
		}
	}
	var pcs []int
	for i := 0; i < 10; i++ {
		reason, err := d.Continue()
		if err != nil {
			t.Fatal(err)
		}
		if reason == Finished {
			break
		}
		if reason != AtBreakpoint {
			t.Fatalf("got %v; want AtBreakpoint", reason)
		}
		pcs = append(pcs, d.Snapshot().PC)
	}
	if want := []int{0, 1, 2}; !reflect.DeepEqual(pcs, want) {
		t.Fatalf("hit PCs = %v; want %v (one hit per line, always progressing)", pcs, want)
	}
	if st := d.Snapshot(); st.Env["x"] != 3 {
		t.Fatalf("unexpected final state: %+v", st)
	}
}

// Adding and removing breakpoints and mixing Continue/Step never changes
// the final result compared to the plain interpreter.
func TestBreakpointChurnMatchesPlainInterpreter(t *testing.T) {
	prog := &Program{Stmts: []Stmt{
		assign(1, "a", "3"),
		assign(2, "b", "4"),
		assign(3, "a", "a * b"),
		printStmt(4, "a"),
		assign(5, "b", "a - b"),
		printStmt(6, "b"),
	}}
	want, err := Run(prog)
	if err != nil {
		t.Fatal(err)
	}

	d := NewDebugger(prog)
	mustAdd := func(line, id int, cond string) {
		t.Helper()
		if err := d.AddBreakpoint(line, id, cond); err != nil {
			t.Fatal(err)
		}
	}
	mustAdd(2, 1, "a == 3")
	mustAdd(3, 1, "b == 4")
	mustAdd(5, 1, "a > 10")
	mustAdd(5, 2, "b < 0")

	reason, err := d.Continue()
	if reason != AtBreakpoint || err != nil {
		t.Fatalf("got %v, %v; want AtBreakpoint", reason, err)
	}
	if !d.RemoveBreakpoint(3, 1) {
		t.Fatal("RemoveBreakpoint reported false")
	}
	if _, err := d.Step(); err != nil {
		t.Fatal(err)
	}
	mustAdd(6, 1, "b == 8")
	if !d.RemoveBreakpoint(5, 1) || !d.RemoveBreakpoint(5, 2) {
		t.Fatal("RemoveBreakpoint reported false")
	}
	for {
		reason, err = d.Continue()
		if err != nil {
			t.Fatal(err)
		}
		if reason == Finished {
			break
		}
	}
	if got := d.Snapshot(); !reflect.DeepEqual(got, *want) {
		t.Fatalf("got %+v; want %+v", got, *want)
	}
}

// Randomized cross-check: for random programs and random breakpoint
// add/remove/continue/step sessions, the debugger's final state must equal
// the plain interpreter's.
func TestRandomizedCrossCheck(t *testing.T) {
	conds := []string{
		"a > 3", "b == c", "a + b < 10", "d % 2 == 0", "0", "1 == 1",
		"zz == 1",   // undefined variable -> ConditionError
		"1 / 0 > 0", // division by zero -> ConditionError
	}
	for seed := int64(0); seed < 300; seed++ {
		r := rand.New(rand.NewSource(seed))
		prog := genProgram(r)
		want, err := Run(prog)
		if err != nil {
			t.Fatalf("seed %d: generated program failed: %v", seed, err)
		}

		d := NewDebugger(prog)
		maxLine := prog.Stmts[len(prog.Stmts)-1].Line()
		nextID := 1
		ops := 0
		for {
			ops++
			if ops > 10000 {
				t.Fatalf("seed %d: no progress", seed)
			}
			switch r.Intn(6) {
			case 0:
				line := 1 + r.Intn(maxLine)
				if err := d.AddBreakpoint(line, nextID, conds[r.Intn(len(conds))]); err == nil {
					nextID++
				}
			case 1:
				d.RemoveBreakpoint(1+r.Intn(maxLine), r.Intn(nextID+1))
			case 2:
				if _, err := d.Step(); err != nil {
					t.Fatalf("seed %d: step: %v", seed, err)
				}
			default:
				reason, err := d.Continue()
				if reason == ConditionError {
					var ce *CondError
					if !errors.As(err, &ce) {
						t.Fatalf("seed %d: not a CondError: %v", seed, err)
					}
					if !d.RemoveBreakpoint(ce.Line, ce.ID) {
						t.Fatalf("seed %d: cannot remove failing breakpoint", seed)
					}
					continue
				}
				if err != nil {
					t.Fatalf("seed %d: continue: %v", seed, err)
				}
			}
			if d.Snapshot().PC >= len(prog.Stmts) {
				break
			}
		}
		if got := d.Snapshot(); !reflect.DeepEqual(got, *want) {
			t.Fatalf("seed %d:\ngot  %+v\nwant %+v", seed, got, *want)
		}
	}
}

func genProgram(r *rand.Rand) *Program {
	vars := []string{"a", "b", "c", "d"}
	stmts := make([]Stmt, 0, 20)
	line := 1
	for _, v := range vars {
		stmts = append(stmts, &Assign{Ln: line, Name: v, Value: Const{V: int64(r.Intn(10))}})
		line++
	}
	for i, n := 0, 5+r.Intn(15); i < n; i++ {
		if r.Intn(4) == 0 {
			stmts = append(stmts, &Print{Ln: line, Value: genExpr(r, vars, 2)})
		} else {
			stmts = append(stmts, &Assign{Ln: line, Name: vars[r.Intn(len(vars))], Value: genExpr(r, vars, 3)})
		}
		line++
	}
	return &Program{Stmts: stmts}
}

func genExpr(r *rand.Rand, vars []string, depth int) Expr {
	if depth == 0 || r.Intn(3) == 0 {
		if r.Intn(2) == 0 {
			return Const{V: int64(r.Intn(20) - 5)}
		}
		return Var{Name: vars[r.Intn(len(vars))]}
	}
	op := []string{"+", "-", "*"}[r.Intn(3)] // no / or %: generated programs never fail
	return Bin{Op: op, L: genExpr(r, vars, depth-1), R: genExpr(r, vars, depth-1)}
}
