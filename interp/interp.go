// Package interp implements a tiny imperative language with a flat,
// PC-addressed statement list, designed to be observed by a debugger.
package interp

import "fmt"

// Stmt is a single executable statement.
type Stmt interface{ stmtNode() }

type Assign struct {
	Name string
	Expr Expr
}
type Print struct{ Expr Expr }
type Goto struct{ Label string }
type IfGoto struct {
	Cond  Expr
	Label string
}
type End struct{}

func (Assign) stmtNode() {}
func (Print) stmtNode()  {}
func (Goto) stmtNode()   {}
func (IfGoto) stmtNode() {}
func (End) stmtNode()    {}

// Program is a flat statement list plus a label table.
type Program struct {
	Stmts  []Stmt
	Labels map[string]int
}

// Len returns the number of statements; valid breakpoint PCs are [0, Len).
func (p *Program) Len() int { return len(p.Stmts) }

// VM executes a Program. Its exported fields are the full observable state.
type VM struct {
	Prog   *Program
	Vars   map[string]int64
	Out    []int64
	PC     int
	Halted bool
}

func NewVM(p *Program) *VM {
	return &VM{Prog: p, Vars: map[string]int64{}}
}

// Step executes exactly the statement at PC. On error the VM state is
// left unchanged (expression evaluation is pure, so a failed statement
// has no observable effect).
func (v *VM) Step() error {
	if v.Halted {
		return fmt.Errorf("cannot step: VM is halted")
	}
	switch s := v.Prog.Stmts[v.PC].(type) {
	case Assign:
		val, err := Eval(s.Expr, v.Vars)
		if err != nil {
			return err
		}
		v.Vars[s.Name] = val
		v.PC++
	case Print:
		val, err := Eval(s.Expr, v.Vars)
		if err != nil {
			return err
		}
		v.Out = append(v.Out, val)
		v.PC++
	case Goto:
		target, ok := v.Prog.Labels[s.Label]
		if !ok {
			return fmt.Errorf("undefined label %q", s.Label)
		}
		v.PC = target
	case IfGoto:
		cond, err := Eval(s.Cond, v.Vars)
		if err != nil {
			return err
		}
		if cond != 0 {
			target, ok := v.Prog.Labels[s.Label]
			if !ok {
				return fmt.Errorf("undefined label %q", s.Label)
			}
			v.PC = target
		} else {
			v.PC++
		}
	case End:
		v.Halted = true
	default:
		return fmt.Errorf("unknown statement %T", s)
	}
	if v.PC >= len(v.Prog.Stmts) {
		v.Halted = true
	}
	return nil
}

// Run executes statements until the VM halts or a statement errors.
func (v *VM) Run() error {
	for !v.Halted {
		if err := v.Step(); err != nil {
			return err
		}
	}
	return nil
}
