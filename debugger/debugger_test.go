package debugger_test

import (
	"math/rand"
	"reflect"
	"strings"
	"testing"

	"example.com/debuglib/debugger"
	"example.com/debuglib/interp"
)

// Statement layout (PC: statement):
//
//	0: let i = 1
//	1: let sum = 0
//	2: if i > 5 goto done
//	3: sum = sum + i
//	4: i = i + 1
//	5: goto loop
//	6: print sum
//	7: end
const prog = `
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

func newDebugged(t *testing.T) *debugger.Debugger {
	t.Helper()
	p, err := interp.Parse(prog)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return debugger.New(interp.NewVM(p))
}

func runPlain(t *testing.T) *interp.VM {
	t.Helper()
	p, err := interp.Parse(prog)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	vm := interp.NewVM(p)
	if err := vm.Run(); err != nil {
		t.Fatalf("run: %v", err)
	}
	return vm
}

func TestBreakpointStopsBeforeStatementExecutes(t *testing.T) {
	d := newDebugged(t)
	id, err := d.AddBreakpoint(3, "sum >= 3")
	if err != nil {
		t.Fatalf("AddBreakpoint: %v", err)
	}
	s := d.Continue()
	if s.Reason != debugger.ReasonBreakpoint || s.PC != 3 || s.ID != id {
		t.Fatalf("stop = %v, want breakpoint at pc=3 id=%d", s, id)
	}
	vm := d.VM()
	if vm.Vars["sum"] != 3 || vm.Vars["i"] != 3 {
		t.Fatalf("vars = %v, want sum=3 i=3 (statement at pc=3 not yet executed)", vm.Vars)
	}
	if vm.PC != 3 {
		t.Fatalf("PC = %d, want 3", vm.PC)
	}
	if !d.RemoveBreakpoint(id) {
		t.Fatalf("RemoveBreakpoint(%d) = false", id)
	}
	if s := d.Continue(); s.Reason != debugger.ReasonHalt {
		t.Fatalf("stop = %v, want halt", s)
	}
	if vm.Vars["sum"] != 15 || !reflect.DeepEqual(vm.Out, []int64{15}) {
		t.Fatalf("final state vars=%v out=%v, want sum=15 out=[15]", vm.Vars, vm.Out)
	}
}

func TestConditionErrorStopsAndPreservesState(t *testing.T) {
	d := newDebugged(t)
	// Errors only when i == 1, i.e. on the first evaluation.
	id, err := d.AddBreakpoint(3, "1 / (i - 1) == 0")
	if err != nil {
		t.Fatalf("AddBreakpoint: %v", err)
	}
	s := d.Continue()
	if s.Reason != debugger.ReasonCondError || s.PC != 3 || s.ID != id {
		t.Fatalf("stop = %v, want cond-error at pc=3 id=%d", s, id)
	}
	if s.Err == nil || !strings.Contains(s.Err.Error(), "division by zero") {
		t.Fatalf("Err = %v, want division by zero", s.Err)
	}
	vm := d.VM()
	if vm.PC != 3 || vm.Vars["i"] != 1 || vm.Vars["sum"] != 0 || len(vm.Out) != 0 {
		t.Fatalf("state not preserved: PC=%d vars=%v out=%v", vm.PC, vm.Vars, vm.Out)
	}
	// State is preserved: remove the faulty breakpoint and finish cleanly.
	d.RemoveBreakpoint(id)
	resumeID, err := d.AddBreakpoint(4, "i == 4")
	if err != nil {
		t.Fatalf("AddBreakpoint: %v", err)
	}
	s = d.Continue()
	if s.Reason != debugger.ReasonBreakpoint || s.PC != 4 {
		t.Fatalf("stop = %v, want breakpoint at pc=4", s)
	}
	if vm.Vars["sum"] != 10 {
		t.Fatalf("sum = %d, want 10 after resuming", vm.Vars["sum"])
	}
	d.RemoveBreakpoint(resumeID)
	if s := d.Continue(); s.Reason != debugger.ReasonHalt {
		t.Fatalf("stop = %v, want halt", s)
	}
	if vm.Vars["sum"] != 15 {
		t.Fatalf("final sum = %d, want 15", vm.Vars["sum"])
	}
}

func TestUndefinedVariableInConditionStops(t *testing.T) {
	d := newDebugged(t)
	if _, err := d.AddBreakpoint(0, "nope > 0"); err != nil {
		t.Fatalf("AddBreakpoint: %v", err)
	}
	s := d.Continue()
	if s.Reason != debugger.ReasonCondError || !strings.Contains(s.Err.Error(), "undefined variable") {
		t.Fatalf("stop = %v, want cond-error undefined variable", s)
	}
	if d.VM().PC != 0 {
		t.Fatalf("PC = %d, want 0 (nothing executed)", d.VM().PC)
	}
}

func TestConditionsAtSamePCRunInIDOrder(t *testing.T) {
	d := newDebugged(t)
	errID, err := d.AddBreakpoint(3, "1 / 0 == 1") // lower ID, errors
	if err != nil {
		t.Fatalf("AddBreakpoint: %v", err)
	}
	trueID, err := d.AddBreakpoint(3, "i == 1") // higher ID, would be true
	if err != nil {
		t.Fatalf("AddBreakpoint: %v", err)
	}
	s := d.Continue()
	if s.Reason != debugger.ReasonCondError || s.ID != errID {
		t.Fatalf("stop = %v, want cond-error from lower-ID breakpoint %d", s, errID)
	}
	// Re-add the erroring condition: it gets a higher ID, so the true
	// condition now wins and the error is never evaluated.
	d.RemoveBreakpoint(errID)
	if _, err := d.AddBreakpoint(3, "1 / 0 == 1"); err != nil {
		t.Fatalf("AddBreakpoint: %v", err)
	}
	s = d.Continue()
	if s.Reason != debugger.ReasonBreakpoint || s.ID != trueID {
		t.Fatalf("stop = %v, want breakpoint from ID %d", s, trueID)
	}
}

func TestStepExecutesExactlyOneStatementIgnoringBreakpoints(t *testing.T) {
	d := newDebugged(t)
	if _, err := d.AddBreakpoint(1, ""); err != nil { // unconditional
		t.Fatalf("AddBreakpoint: %v", err)
	}
	s := d.Step()
	if s.Reason != debugger.ReasonStep || d.VM().PC != 1 {
		t.Fatalf("stop = %v PC=%d, want step stop at pc=1", s, d.VM().PC)
	}
	if _, ok := d.VM().Vars["i"]; !ok {
		t.Fatalf("statement at pc=0 was not executed: vars=%v", d.VM().Vars)
	}
	// The unconditional breakpoint at pc=1 must not fire during Step.
	s = d.Step()
	if s.Reason != debugger.ReasonStep || d.VM().PC != 2 {
		t.Fatalf("stop = %v PC=%d, want step stop at pc=2", s, d.VM().PC)
	}
	// But Continue is stopped by it before executing pc=2... pc=2 has no
	// breakpoint; move back to pc=1 semantics check via a fresh debugger.
	d2 := newDebugged(t)
	if _, err := d2.AddBreakpoint(1, ""); err != nil {
		t.Fatalf("AddBreakpoint: %v", err)
	}
	s = d2.Continue()
	if s.Reason != debugger.ReasonBreakpoint || s.PC != 1 {
		t.Fatalf("stop = %v, want breakpoint at pc=1", s)
	}
	// Continue re-checks the current PC, so it stops again immediately;
	// Step is the deterministic way past an always-true breakpoint.
	if s := d2.Continue(); s.Reason != debugger.ReasonBreakpoint || s.PC != 1 {
		t.Fatalf("stop = %v, want immediate re-stop at pc=1", s)
	}
	if s := d2.Step(); s.Reason != debugger.ReasonStep || d2.VM().PC != 2 {
		t.Fatalf("stop = %v, want step to pc=2", s)
	}
}

func TestStepOnHaltedVM(t *testing.T) {
	d := newDebugged(t)
	for s := d.Step(); s.Reason != debugger.ReasonHalt; s = d.Step() {
	}
	if !d.VM().Halted {
		t.Fatal("VM not halted after stepping to halt")
	}
	if s := d.Step(); s.Reason != debugger.ReasonHalt {
		t.Fatalf("Step on halted VM = %v, want halt", s)
	}
	if s := d.Continue(); s.Reason != debugger.ReasonHalt {
		t.Fatalf("Continue on halted VM = %v, want halt", s)
	}
	if d.VM().Vars["sum"] != 15 {
		t.Fatalf("sum = %d, want 15", d.VM().Vars["sum"])
	}
}

func TestContinueWithoutBreakpointsRunsToHalt(t *testing.T) {
	d := newDebugged(t)
	s := d.Continue()
	if s.Reason != debugger.ReasonHalt {
		t.Fatalf("stop = %v, want halt", s)
	}
	if d.VM().Vars["sum"] != 15 || !reflect.DeepEqual(d.VM().Out, []int64{15}) {
		t.Fatalf("vars=%v out=%v, want sum=15 out=[15]", d.VM().Vars, d.VM().Out)
	}
}

func TestAddBreakpointValidation(t *testing.T) {
	d := newDebugged(t)
	if _, err := d.AddBreakpoint(-1, ""); err == nil {
		t.Error("negative pc accepted")
	}
	if _, err := d.AddBreakpoint(d.VM().Prog.Len(), ""); err == nil {
		t.Error("pc == Len accepted")
	}
	if _, err := d.AddBreakpoint(0, "sum = 5"); err == nil {
		t.Error("assignment accepted as condition")
	}
	if _, err := d.AddBreakpoint(0, "print sum"); err == nil {
		t.Error("print statement accepted as condition")
	}
	if d.RemoveBreakpoint(999) {
		t.Error("RemoveBreakpoint(999) = true, want false")
	}
	if got := len(d.Breakpoints()); got != 0 {
		t.Errorf("Breakpoints() len = %d, want 0", got)
	}
}

func TestConditionEvaluationDoesNotMutateState(t *testing.T) {
	d := newDebugged(t)
	if _, err := d.AddBreakpoint(3, "sum * 2 + i % 3 >= 0"); err != nil {
		t.Fatalf("AddBreakpoint: %v", err)
	}
	s := d.Continue()
	if s.Reason != debugger.ReasonBreakpoint {
		t.Fatalf("stop = %v, want breakpoint", s)
	}
	before := map[string]int64{}
	for k, v := range d.VM().Vars {
		before[k] = v
	}
	// Re-evaluate conditions many times via Continue; each stop must
	// leave the state bit-identical.
	for i := 0; i < 20; i++ {
		s = d.Continue()
		if s.Reason != debugger.ReasonBreakpoint {
			t.Fatalf("stop = %v, want breakpoint", s)
		}
		if !reflect.DeepEqual(d.VM().Vars, before) {
			t.Fatalf("condition evaluation mutated vars: %v -> %v", before, d.VM().Vars)
		}
	}
}

func TestDebugRunMatchesPlainInterpreter(t *testing.T) {
	want := runPlain(t)
	d := newDebugged(t)
	ids := []int{}
	for _, a := range []struct {
		pc   int
		cond string
	}{{2, "i > 2"}, {3, ""}, {4, "sum % 2 == 0"}, {6, ""}} {
		id, err := d.AddBreakpoint(a.pc, a.cond)
		if err != nil {
			t.Fatalf("AddBreakpoint: %v", err)
		}
		ids = append(ids, id)
	}
	// Arbitrary interleaving of stops, steps, removals and continues.
	for !d.VM().Halted {
		s := d.Continue()
		switch s.Reason {
		case debugger.ReasonHalt:
		case debugger.ReasonBreakpoint:
			d.Step()
			if len(ids) > 0 {
				d.RemoveBreakpoint(ids[0])
				ids = ids[1:]
			}
		default:
			t.Fatalf("unexpected stop: %v", s)
		}
	}
	if !reflect.DeepEqual(d.VM().Vars, want.Vars) {
		t.Errorf("vars = %v, want %v", d.VM().Vars, want.Vars)
	}
	if !reflect.DeepEqual(d.VM().Out, want.Out) {
		t.Errorf("out = %v, want %v", d.VM().Out, want.Out)
	}
}

// Deterministic fuzz: random sequences of add/remove/step/continue must
// always converge to the plain interpreter's final state.
func TestFuzzDebugRunMatchesPlainInterpreter(t *testing.T) {
	want := runPlain(t)
	conds := []string{"", "i > 3", "sum == 10", "i % 2 == 0", "1 / 0 == 1", "sum < 100"}
	for seed := int64(0); seed < 100; seed++ {
		rng := rand.New(rand.NewSource(seed))
		p, err := interp.Parse(prog)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		vm := interp.NewVM(p)
		d := debugger.New(vm)
		var ids []int
		for steps := 0; !vm.Halted; steps++ {
			if steps > 100000 {
				t.Fatalf("seed %d: run did not terminate", seed)
			}
			switch rng.Intn(4) {
			case 0:
				d.Step()
			case 1:
				d.Continue()
			case 2:
				id, err := d.AddBreakpoint(rng.Intn(p.Len()), conds[rng.Intn(len(conds))])
				if err == nil {
					ids = append(ids, id)
				}
			case 3:
				if len(ids) > 0 {
					d.RemoveBreakpoint(ids[rng.Intn(len(ids))])
				}
			}
		}
		if !reflect.DeepEqual(vm.Vars, want.Vars) {
			t.Errorf("seed %d: vars = %v, want %v", seed, vm.Vars, want.Vars)
		}
		if !reflect.DeepEqual(vm.Out, want.Out) {
			t.Errorf("seed %d: out = %v, want %v", seed, vm.Out, want.Out)
		}
	}
}
