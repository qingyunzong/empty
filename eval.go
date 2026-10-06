package foldexpr

import "fmt"

// TrapError is returned by Eval when evaluation reaches a division
// (or remainder) by zero, either directly in the source AST or via a
// Trap node produced by Fold. Pos is the byte offset of the operator
// in the original source.
type TrapError struct {
	Pos    int
	Reason string
}

func (e *TrapError) Error() string {
	return fmt.Sprintf("trap at offset %d: %s", e.Pos, e.Reason)
}

// UndefinedError is returned by Eval when a variable is missing from
// the environment.
type UndefinedError struct {
	Pos  int
	Name string
}

func (e *UndefinedError) Error() string {
	return fmt.Sprintf("undefined variable %q at offset %d", e.Name, e.Pos)
}

// Eval evaluates n under env with 32-bit wraparound arithmetic.
// "&&", "||" and "?:" short-circuit: unexecuted branches are never
// evaluated, so a division by zero inside them does not trap.
func Eval(n Node, env map[string]int32) (int32, error) {
	switch n := n.(type) {
	case *Const:
		return n.Val, nil
	case *Var:
		v, ok := env[n.Name]
		if !ok {
			return 0, &UndefinedError{Pos: n.P, Name: n.Name}
		}
		return v, nil
	case *Trap:
		return 0, &TrapError{Pos: n.P, Reason: n.Reason}
	case *Unary:
		x, err := Eval(n.X, env)
		if err != nil {
			return 0, err
		}
		switch n.Op {
		case "-":
			return -x, nil
		case "!":
			return boolConst(x == 0), nil
		}
	case *Binary:
		switch n.Op {
		case "&&":
			l, err := Eval(n.L, env)
			if err != nil {
				return 0, err
			}
			if l == 0 {
				return 0, nil
			}
			r, err := Eval(n.R, env)
			if err != nil {
				return 0, err
			}
			return boolConst(r != 0), nil
		case "||":
			l, err := Eval(n.L, env)
			if err != nil {
				return 0, err
			}
			if l != 0 {
				return 1, nil
			}
			r, err := Eval(n.R, env)
			if err != nil {
				return 0, err
			}
			return boolConst(r != 0), nil
		}
		l, err := Eval(n.L, env)
		if err != nil {
			return 0, err
		}
		r, err := Eval(n.R, env)
		if err != nil {
			return 0, err
		}
		switch n.Op {
		case "+":
			return l + r, nil
		case "-":
			return l - r, nil
		case "*":
			return l * r, nil
		case "/":
			if r == 0 {
				return 0, &TrapError{Pos: n.P, Reason: "division by zero"}
			}
			return l / r, nil
		case "%":
			if r == 0 {
				return 0, &TrapError{Pos: n.P, Reason: "remainder by zero"}
			}
			return l % r, nil
		case "==":
			return boolConst(l == r), nil
		case "!=":
			return boolConst(l != r), nil
		case "<":
			return boolConst(l < r), nil
		case "<=":
			return boolConst(l <= r), nil
		case ">":
			return boolConst(l > r), nil
		case ">=":
			return boolConst(l >= r), nil
		}
	case *Cond:
		c, err := Eval(n.C, env)
		if err != nil {
			return 0, err
		}
		if c != 0 {
			return Eval(n.T, env)
		}
		return Eval(n.F, env)
	}
	return 0, fmt.Errorf("unknown node %T", n)
}

func boolConst(b bool) int32 {
	if b {
		return 1
	}
	return 0
}
