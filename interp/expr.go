package interp

import "fmt"

// Expr is a pure expression: evaluation never mutates program state.
type Expr interface{ exprNode() }

type NumLit struct{ Val int64 }
type Var struct{ Name string }
type Unary struct {
	Op string
	X  Expr
}
type Binary struct {
	Op   string
	L, R Expr
}

func (NumLit) exprNode() {}
func (Var) exprNode()    {}
func (Unary) exprNode()  {}
func (Binary) exprNode() {}

// IsPure reports whether e is free of side effects. Every expression
// construct in this language is pure by construction; the check is
// structural so that any future extension must re-prove purity.
func IsPure(e Expr) bool {
	switch n := e.(type) {
	case NumLit, Var:
		return true
	case Unary:
		return IsPure(n.X)
	case Binary:
		return IsPure(n.L) && IsPure(n.R)
	default:
		return false
	}
}

// Eval evaluates e against vars. It never modifies vars.
func Eval(e Expr, vars map[string]int64) (int64, error) {
	switch n := e.(type) {
	case NumLit:
		return n.Val, nil
	case Var:
		v, ok := vars[n.Name]
		if !ok {
			return 0, fmt.Errorf("undefined variable %q", n.Name)
		}
		return v, nil
	case Unary:
		x, err := Eval(n.X, vars)
		if err != nil {
			return 0, err
		}
		switch n.Op {
		case "-":
			return -x, nil
		case "!":
			if x == 0 {
				return 1, nil
			}
			return 0, nil
		}
		return 0, fmt.Errorf("unknown unary operator %q", n.Op)
	case Binary:
		l, err := Eval(n.L, vars)
		if err != nil {
			return 0, err
		}
		r, err := Eval(n.R, vars)
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
				return 0, fmt.Errorf("division by zero")
			}
			return l / r, nil
		case "%":
			if r == 0 {
				return 0, fmt.Errorf("modulo by zero")
			}
			return l % r, nil
		case "<":
			return b2i(l < r), nil
		case "<=":
			return b2i(l <= r), nil
		case ">":
			return b2i(l > r), nil
		case ">=":
			return b2i(l >= r), nil
		case "==":
			return b2i(l == r), nil
		case "!=":
			return b2i(l != r), nil
		}
		return 0, fmt.Errorf("unknown binary operator %q", n.Op)
	}
	return 0, fmt.Errorf("unknown expression node %T", e)
}

func b2i(b bool) int64 {
	if b {
		return 1
	}
	return 0
}
