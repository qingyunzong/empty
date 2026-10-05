package debuglib

import "fmt"

// StopReason describes why the debugger stopped.
type StopReason int

const (
	// AtBreakpoint: a breakpoint condition held before executing the
	// statement at the current PC; that statement has NOT executed yet.
	AtBreakpoint StopReason = iota
	// AtStatement: Step executed exactly one statement.
	AtStatement
	// ConditionError: evaluating a breakpoint condition failed. Nothing
	// was executed and the state is preserved exactly as before the call.
	ConditionError
	// RuntimeError: the program itself failed while executing a statement.
	RuntimeError
	// Finished: the program ran to completion.
	Finished
)

func (r StopReason) String() string {
	switch r {
	case AtBreakpoint:
		return "AtBreakpoint"
	case AtStatement:
		return "AtStatement"
	case ConditionError:
		return "ConditionError"
	case RuntimeError:
		return "RuntimeError"
	case Finished:
		return "Finished"
	}
	return "unknown"
}

// CondError reports a failing breakpoint condition. The debugger state is
// left untouched when this error is returned.
type CondError struct {
	Line int
	ID   int
	Err  error
}

func (e *CondError) Error() string {
	return fmt.Sprintf("breakpoint %d at line %d: %v", e.ID, e.Line, e.Err)
}

func (e *CondError) Unwrap() error { return e.Err }

type breakpoint struct {
	id   int
	cond Expr
}

// Debugger interprets a program with conditional breakpoints.
//
// Semantics:
//   - Conditions are pure expressions; they are evaluated before the
//     statement at their line executes and cannot change the program.
//   - At one line, conditions are evaluated in ascending breakpoint ID
//     order; evaluation stops at the first true condition (a hit) or the
//     first error (ConditionError, state preserved).
//   - Continue runs statements until a condition holds, the program ends,
//     or an error occurs. To guarantee progress, a breakpoint hit at the
//     current PC is not re-checked by the immediately following Continue.
//   - Step executes exactly one statement, ignoring breakpoints, then
//     stops (AtStatement), or reports Finished/RuntimeError.
type Debugger struct {
	prog  *Program
	state *State
	bps   map[int][]breakpoint // line -> breakpoints sorted by ascending id

	lastStop  StopReason
	lastHitPC int
}

func NewDebugger(p *Program) *Debugger {
	return &Debugger{prog: p, state: NewState(), bps: map[int][]breakpoint{}, lastHitPC: -1}
}

// Snapshot returns a deep copy of the current state.
func (d *Debugger) Snapshot() State {
	env := make(map[string]int64, len(d.state.Env))
	for k, v := range d.state.Env {
		env[k] = v
	}
	return State{
		Env: env,
		Out: append([]int64(nil), d.state.Out...),
		PC:  d.state.PC,
	}
}

// AddBreakpoint attaches a pure condition to a line. The condition is
// parsed immediately; a duplicate (line, id) pair is an error.
func (d *Debugger) AddBreakpoint(line, id int, condSrc string) error {
	cond, err := ParseExpr(condSrc)
	if err != nil {
		return fmt.Errorf("breakpoint %d at line %d: %w", id, line, err)
	}
	conds := d.bps[line]
	i := 0
	for i < len(conds) && conds[i].id < id {
		i++
	}
	if i < len(conds) && conds[i].id == id {
		return fmt.Errorf("duplicate breakpoint id %d at line %d", id, line)
	}
	conds = append(conds, breakpoint{})
	copy(conds[i+1:], conds[i:])
	conds[i] = breakpoint{id: id, cond: cond}
	d.bps[line] = conds
	return nil
}

// RemoveBreakpoint deletes the breakpoint (line, id); it reports whether
// one existed.
func (d *Debugger) RemoveBreakpoint(line, id int) bool {
	conds := d.bps[line]
	for i, bp := range conds {
		if bp.id == id {
			conds = append(conds[:i], conds[i+1:]...)
			if len(conds) == 0 {
				delete(d.bps, line)
			} else {
				d.bps[line] = conds
			}
			return true
		}
	}
	return false
}

// checkConds evaluates the conditions at the current line in ascending ID
// order. It reports a hit on the first true condition, or a *CondError on
// the first failing one. It never mutates the state.
func (d *Debugger) checkConds() (hit bool, err error) {
	line := d.prog.Stmts[d.state.PC].Line()
	for _, bp := range d.bps[line] {
		v, err := bp.cond.Eval(d.state.Env)
		if err != nil {
			return false, &CondError{Line: line, ID: bp.id, Err: err}
		}
		if v != 0 {
			return true, nil
		}
	}
	return false, nil
}

// Continue runs until the next breakpoint hit, an error, or completion.
// If the previous stop was a breakpoint hit at the current PC, that line's
// conditions are skipped once so execution always makes progress.
func (d *Debugger) Continue() (StopReason, error) {
	first := true
	for {
		if d.state.PC >= len(d.prog.Stmts) {
			d.lastStop = Finished
			return Finished, nil
		}
		skip := first && d.lastStop == AtBreakpoint && d.lastHitPC == d.state.PC
		first = false
		if !skip {
			hit, err := d.checkConds()
			if err != nil {
				d.lastStop = ConditionError
				return ConditionError, err
			}
			if hit {
				d.lastStop = AtBreakpoint
				d.lastHitPC = d.state.PC
				return AtBreakpoint, nil
			}
		}
		if err := d.prog.step(d.state); err != nil {
			d.lastStop = RuntimeError
			return RuntimeError, err
		}
	}
}

// Step executes exactly one statement, ignoring breakpoints.
func (d *Debugger) Step() (StopReason, error) {
	if d.state.PC >= len(d.prog.Stmts) {
		d.lastStop = Finished
		return Finished, nil
	}
	if err := d.prog.step(d.state); err != nil {
		d.lastStop = RuntimeError
		return RuntimeError, err
	}
	if d.state.PC >= len(d.prog.Stmts) {
		d.lastStop = Finished
		return Finished, nil
	}
	d.lastStop = AtStatement
	return AtStatement, nil
}
