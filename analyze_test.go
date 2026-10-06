package rescheck

import (
	"strings"
	"testing"
)

func kinds(vs []Violation) []string {
	var out []string
	for _, v := range vs {
		out = append(out, v.Kind)
	}
	return out
}

func hasViolation(vs []Violation, kind, var_ string) bool {
	for _, v := range vs {
		if v.Kind == kind && v.Var == var_ {
			return true
		}
	}
	return false
}

func mustConsistent(t *testing.T, d *Diagnosis) {
	t.Helper()
	if len(d.Consistency) != 0 {
		t.Fatalf("merge-point inconsistency:\n%s", strings.Join(d.Consistency, "\n"))
	}
}

// new; use; return — the minimal well-formed program.
func TestStraightLineOK(t *testing.T) {
	p := NewProgram()
	p.Block("entry", New("x"), Use("x"), Ret())

	d := Diagnose(p, 2)
	if len(d.Violations) != 0 {
		t.Fatalf("expected no violations, got:\n%s", d.Report())
	}
	mustConsistent(t, d)
	if !d.FixedPointOK {
		t.Fatal("fixed point should hold trivially without loops")
	}
}

// use; use — the second consume must be flagged with its path.
func TestDoubleConsume(t *testing.T) {
	p := NewProgram()
	p.Block("entry", New("x"), Use("x"), Use("x"), Ret())

	d := Diagnose(p, 2)
	if !hasViolation(d.Violations, "double-consume", "x") {
		t.Fatalf("expected double-consume, got:\n%s", d.Report())
	}
	for _, v := range d.Violations {
		if v.Kind == "double-consume" {
			want := "entry"
			if strings.Join(v.Path, " -> ") != want {
				t.Fatalf("violating path = %v, want %v", v.Path, want)
			}
		}
	}
	mustConsistent(t, d)
}

// Resource still live at the normal exit.
func TestLeakAtReturn(t *testing.T) {
	p := NewProgram()
	p.Block("entry", New("x"), Ret())

	d := Diagnose(p, 2)
	if !hasViolation(d.Violations, "leak-at-return", "x") {
		t.Fatalf("expected leak-at-return, got:\n%s", d.Report())
	}
	mustConsistent(t, d)
}

// Exceptional exits must consume too.
func TestLeakAtPanic(t *testing.T) {
	p := NewProgram()
	entry := p.Block("entry", New("x"))
	fail := p.Block("fail", Panic())
	Link(entry, fail)

	d := Diagnose(p, 2)
	if !hasViolation(d.Violations, "leak-at-panic", "x") {
		t.Fatalf("expected leak-at-panic, got:\n%s", d.Report())
	}
	for _, v := range d.Violations {
		if v.Kind == "leak-at-panic" {
			want := "entry -> fail"
			if strings.Join(v.Path, " -> ") != want {
				t.Fatalf("violating path = %v, want %v", v.Path, want)
			}
		}
	}
	mustConsistent(t, d)
}

// Consuming before the panic is fine.
func TestPanicAfterConsumeOK(t *testing.T) {
	p := NewProgram()
	entry := p.Block("entry", New("x"), Use("x"))
	fail := p.Block("fail", Panic())
	Link(entry, fail)

	d := Diagnose(p, 2)
	if len(d.Violations) != 0 {
		t.Fatalf("expected no violations, got:\n%s", d.Report())
	}
	mustConsistent(t, d)
}

// move transfers ownership: using the target is fine, the source is dead.
func TestMoveSemantics(t *testing.T) {
	p := NewProgram()
	p.Block("entry", New("x"), Move("y", "x"), Use("y"), Ret())
	if d := Diagnose(p, 2); len(d.Violations) != 0 {
		t.Fatalf("move+use target should be clean, got:\n%s", d.Report())
	}

	p2 := NewProgram()
	p2.Block("entry", New("x"), Move("y", "x"), Use("x"), Use("y"), Ret())
	d2 := Diagnose(p2, 2)
	if !hasViolation(d2.Violations, "use-after-move", "x") {
		t.Fatalf("expected use-after-move, got:\n%s", d2.Report())
	}
	mustConsistent(t, d2)
}

// A move does not consume: the new owner must still be used.
func TestMoveDoesNotConsume(t *testing.T) {
	p := NewProgram()
	p.Block("entry", New("x"), Move("y", "x"), Ret())

	d := Diagnose(p, 2)
	if !hasViolation(d.Violations, "leak-at-return", "y") {
		t.Fatalf("expected leak of moved-to var y, got:\n%s", d.Report())
	}
	if hasViolation(d.Violations, "leak-at-return", "x") {
		t.Fatalf("moved-from x must not leak, got:\n%s", d.Report())
	}
	mustConsistent(t, d)
}

// Consumed on one branch only: the merge point must flag the conflict
// and the exit must flag the maybe-leak.
func TestBranchMergeConflict(t *testing.T) {
	p := NewProgram()
	entry := p.Block("entry", New("x"))
	then := p.Block("then", Use("x"))
	els := p.Block("else")
	merge := p.Block("merge", Ret())
	Link(entry, then)
	Link(entry, els)
	Link(then, merge)
	Link(els, merge)

	d := Diagnose(p, 2)
	if !hasViolation(d.Violations, "merge-conflict", "x") {
		t.Fatalf("expected merge-conflict, got:\n%s", d.Report())
	}
	if !hasViolation(d.Violations, "maybe-leak-at-return", "x") {
		t.Fatalf("expected maybe-leak-at-return, got:\n%s", d.Report())
	}
	if got := d.Result.In[merge].Vars["x"]; got != Conflict {
		t.Fatalf("merge in-state of x = %s, want conflict", got)
	}
	mustConsistent(t, d)
}

// Both branches consume: clean, and the merge state is consumed.
func TestBranchBothConsumeOK(t *testing.T) {
	p := NewProgram()
	entry := p.Block("entry", New("x"))
	then := p.Block("then", Use("x"))
	els := p.Block("else", Use("x"))
	merge := p.Block("merge", Ret())
	Link(entry, then)
	Link(entry, els)
	Link(then, merge)
	Link(els, merge)

	d := Diagnose(p, 2)
	if len(d.Violations) != 0 {
		t.Fatalf("expected no violations, got:\n%s", d.Report())
	}
	if got := d.Result.In[merge].Vars["x"]; got != Consumed {
		t.Fatalf("merge in-state of x = %s, want consumed", got)
	}
	mustConsistent(t, d)
}

// Double consume reachable through only one branch: the violating path
// must go through that branch.
func TestViolatingPathThroughBranch(t *testing.T) {
	p := NewProgram()
	entry := p.Block("entry", New("x"))
	a := p.Block("a", Use("x"))
	b := p.Block("b")
	merge := p.Block("merge", Use("x"), Ret())
	Link(entry, a)
	Link(entry, b)
	Link(a, merge)
	Link(b, merge)

	d := Diagnose(p, 2)
	found := false
	for _, v := range d.Expanded.Violations {
		if v.Kind == "double-consume" && v.Var == "x" {
			found = true
			want := "entry -> a -> merge"
			if strings.Join(v.Path, " -> ") != want {
				t.Fatalf("violating path = %v, want %v", v.Path, want)
			}
		}
	}
	if !found {
		t.Fatalf("expected a double-consume violation, got:\n%s", d.Report())
	}
}

// Loop that re-creates the resource each iteration: clean, and the
// loop-head state must be the fixed point live.
func TestLoopFixedPoint(t *testing.T) {
	p := NewProgram()
	entry := p.Block("entry", New("x"))
	loop := p.Block("loop", Use("x"), New("x"))
	exit := p.Block("exit", Use("x"), Ret())
	Link(entry, loop)
	Link(loop, loop) // back edge
	Link(loop, exit)

	d := Diagnose(p, 3)
	if len(d.Violations) != 0 {
		t.Fatalf("expected no violations, got:\n%s", d.Report())
	}
	if got := d.Result.In[loop].Vars["x"]; got != Live {
		t.Fatalf("loop-head in-state of x = %s, want live", got)
	}
	if d.Result.Iterations <= len(p.Blocks) {
		t.Fatalf("loop should force re-iteration, iterations=%d", d.Result.Iterations)
	}
	if !FixedPointReached(p, 1) {
		t.Fatal("loop-head states should be stable after 1 unrolling")
	}
	if !d.FixedPointOK {
		t.Fatal("diagnosis should confirm the loop fixed point")
	}
	mustConsistent(t, d)
}

// Loop that consumes without re-creating: the header sees live (first
// entry) and consumed (back edge), so the fixed point needs 2
// unrollings and the merge must be flagged.
func TestLoopConsumeWithoutRecreate(t *testing.T) {
	p := NewProgram()
	entry := p.Block("entry", New("x"))
	loop := p.Block("loop", Use("x"))
	exit := p.Block("exit", Ret())
	Link(entry, loop)
	Link(loop, loop)
	Link(loop, exit)

	d := Diagnose(p, 3)
	if !hasViolation(d.Violations, "merge-conflict", "x") {
		t.Fatalf("expected merge-conflict at loop head, got:\n%s", d.Report())
	}
	if FixedPointReached(p, 1) {
		t.Fatal("1 unrolling must not reach the fixed point here")
	}
	if !FixedPointReached(p, 2) {
		t.Fatal("fixed point should be reached after 2 unrollings")
	}
	mustConsistent(t, d)
}

// Leak inside a loop body is reported on the exceptional path too.
func TestLoopPanicLeak(t *testing.T) {
	p := NewProgram()
	entry := p.Block("entry", New("x"))
	loop := p.Block("loop")
	bad := p.Block("bad", Panic())
	exit := p.Block("exit", Use("x"), Ret())
	Link(entry, loop)
	Link(loop, loop)
	Link(loop, bad)
	Link(loop, exit)

	d := Diagnose(p, 3)
	if !hasViolation(d.Violations, "leak-at-panic", "x") {
		t.Fatalf("expected leak-at-panic, got:\n%s", d.Report())
	}
	mustConsistent(t, d)
}

// LoopHeaders finds exactly the back-edge targets.
func TestLoopHeaders(t *testing.T) {
	p := NewProgram()
	entry := p.Block("entry", New("x"))
	loop := p.Block("loop", Use("x"), New("x"))
	exit := p.Block("exit", Use("x"), Ret())
	Link(entry, loop)
	Link(loop, loop)
	Link(loop, exit)

	headers := LoopHeaders(p)
	if len(headers) != 1 || headers[0] != loop {
		t.Fatalf("headers = %v, want [loop]", headers)
	}
}

// use-before-init and move-before-init are caught on concrete paths.
func TestUninitializedUse(t *testing.T) {
	p := NewProgram()
	p.Block("entry", Use("x"), Ret())
	if d := Diagnose(p, 2); !hasViolation(d.Violations, "use-before-init", "x") {
		t.Fatalf("expected use-before-init, got:\n%s", d.Report())
	}

	p2 := NewProgram()
	p2.Block("entry", Move("y", "x"), Ret())
	if d := Diagnose(p2, 2); !hasViolation(d.Violations, "move-before-init", "x") {
		t.Fatalf("expected move-before-init, got:\n%s", d.Report())
	}
}
