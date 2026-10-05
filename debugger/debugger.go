// Package debugger wraps an interp.VM with conditional breakpoints.
//
// Semantics (all deterministic):
//
//   - Breakpoint conditions are pure expressions (interp.IsPure); they are
//     evaluated BEFORE the statement at their PC executes and can never
//     mutate program state.
//   - At one PC, conditions are evaluated in increasing breakpoint ID
//     order; the first true condition (or the first evaluation error)
//     stops execution and later conditions at that PC are not evaluated.
//   - A condition evaluation error stops execution with ReasonCondError;
//     the statement is not executed and the VM state is fully preserved,
//     so the run can be resumed after removing or fixing the breakpoint.
//   - Continue runs statements until a breakpoint stops it, a statement
//     errors, or the VM halts. It re-checks breakpoints at the current PC,
//     so an always-true breakpoint stops Continue immediately; use Step
//     (or remove the breakpoint) to move past it.
//   - Step executes exactly one statement, ignoring breakpoints, then
//     stops with ReasonStep. On a halted VM it is a no-op returning
//     ReasonHalt.
//   - Adding or removing breakpoints never changes the final result of a
//     program: conditions are pure and stopped runs resume identically.
package debugger

import (
	"fmt"
	"sort"

	"example.com/debuglib/interp"
)

// Reason describes why the debugger stopped.
type Reason int

const (
	// ReasonHalt: the VM halted (program finished).
	ReasonHalt Reason = iota
	// ReasonBreakpoint: a breakpoint condition at Stop.PC was true.
	ReasonBreakpoint
	// ReasonCondError: a breakpoint condition at Stop.PC failed to
	// evaluate; Stop.Err holds the error and the VM state is preserved.
	ReasonCondError
	// ReasonStep: Step executed exactly one statement.
	ReasonStep
	// ReasonError: a statement itself failed; Stop.Err holds the error.
	ReasonError
)

func (r Reason) String() string {
	switch r {
	case ReasonHalt:
		return "halt"
	case ReasonBreakpoint:
		return "breakpoint"
	case ReasonCondError:
		return "cond-error"
	case ReasonStep:
		return "step"
	case ReasonError:
		return "error"
	}
	return "unknown"
}

// Stop describes a stop event returned by Continue and Step.
type Stop struct {
	Reason Reason
	PC     int   // PC at which execution stopped
	ID     int   // breakpoint ID (ReasonBreakpoint / ReasonCondError only)
	Err    error // condition or statement error, if any
}

func (s Stop) String() string {
	if s.Err != nil {
		return fmt.Sprintf("%s at pc=%d id=%d: %v", s.Reason, s.PC, s.ID, s.Err)
	}
	return fmt.Sprintf("%s at pc=%d id=%d", s.Reason, s.PC, s.ID)
}

// Info describes a registered breakpoint.
type Info struct {
	ID   int
	PC   int
	Cond string // empty means unconditional
}

type breakpoint struct {
	id   int
	pc   int
	cond interp.Expr // nil means unconditional
	src  string
}

// Debugger observes and controls one interp.VM.
type Debugger struct {
	vm     *interp.VM
	bps    map[int]*breakpoint
	nextID int
}

func New(vm *interp.VM) *Debugger {
	return &Debugger{vm: vm, bps: map[int]*breakpoint{}}
}

// VM returns the observed interpreter.
func (d *Debugger) VM() *interp.VM { return d.vm }

// AddBreakpoint registers a breakpoint at pc. condSrc must be empty
// (unconditional) or a pure expression in the interp expression language;
// anything else is rejected with an error. It returns the breakpoint ID,
// which increases monotonically over the life of the Debugger.
func (d *Debugger) AddBreakpoint(pc int, condSrc string) (int, error) {
	if pc < 0 || pc >= d.vm.Prog.Len() {
		return 0, fmt.Errorf("pc %d out of range [0, %d)", pc, d.vm.Prog.Len())
	}
	var cond interp.Expr
	if condSrc != "" {
		e, err := interp.ParseExpr(condSrc)
		if err != nil {
			return 0, fmt.Errorf("invalid breakpoint condition %q: %w", condSrc, err)
		}
		if !interp.IsPure(e) {
			return 0, fmt.Errorf("breakpoint condition %q is not pure", condSrc)
		}
		cond = e
	}
	d.nextID++
	d.bps[d.nextID] = &breakpoint{id: d.nextID, pc: pc, cond: cond, src: condSrc}
	return d.nextID, nil
}

// RemoveBreakpoint deletes a breakpoint by ID, reporting whether it existed.
func (d *Debugger) RemoveBreakpoint(id int) bool {
	if _, ok := d.bps[id]; !ok {
		return false
	}
	delete(d.bps, id)
	return true
}

// Breakpoints lists registered breakpoints in increasing ID order.
func (d *Debugger) Breakpoints() []Info {
	ids := make([]int, 0, len(d.bps))
	for id := range d.bps {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	infos := make([]Info, 0, len(ids))
	for _, id := range ids {
		b := d.bps[id]
		infos = append(infos, Info{ID: b.id, PC: b.pc, Cond: b.src})
	}
	return infos
}

// check evaluates the conditions registered at pc in increasing ID order.
// Evaluation is pure: it cannot modify the VM. The first true condition or
// the first error stops the run; remaining conditions are not evaluated.
func (d *Debugger) check(pc int) (Stop, bool) {
	for _, info := range d.Breakpoints() {
		b := d.bps[info.ID]
		if b.pc != pc {
			continue
		}
		if b.cond == nil {
			return Stop{Reason: ReasonBreakpoint, PC: pc, ID: b.id}, true
		}
		v, err := interp.Eval(b.cond, d.vm.Vars)
		if err != nil {
			return Stop{Reason: ReasonCondError, PC: pc, ID: b.id, Err: err}, true
		}
		if v != 0 {
			return Stop{Reason: ReasonBreakpoint, PC: pc, ID: b.id}, true
		}
	}
	return Stop{}, false
}

// Continue executes statements until a breakpoint stops the run, a
// statement errors, or the VM halts. Breakpoints are checked before each
// statement, including the one at the current PC.
func (d *Debugger) Continue() Stop {
	for {
		if d.vm.Halted {
			return Stop{Reason: ReasonHalt, PC: d.vm.PC}
		}
		pc := d.vm.PC
		if s, ok := d.check(pc); ok {
			return s
		}
		if err := d.vm.Step(); err != nil {
			return Stop{Reason: ReasonError, PC: pc, Err: err}
		}
	}
}

// Step executes exactly one statement, ignoring breakpoints, and stops
// with ReasonStep. On a halted VM it does nothing and returns ReasonHalt.
func (d *Debugger) Step() Stop {
	if d.vm.Halted {
		return Stop{Reason: ReasonHalt, PC: d.vm.PC}
	}
	pc := d.vm.PC
	if err := d.vm.Step(); err != nil {
		return Stop{Reason: ReasonError, PC: pc, Err: err}
	}
	return Stop{Reason: ReasonStep, PC: d.vm.PC}
}
