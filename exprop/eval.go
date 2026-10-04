package exprop

import "fmt"

// EvalError is a runtime error with the source position that triggered it.
type EvalError struct {
	At  Pos
	Msg string
}

func (e *EvalError) Error() string { return fmt.Sprintf("%s: %s", e.At, e.Msg) }

// Eval evaluates e left to right and returns the first observable error.
func Eval(e Expr) (int64, error) {
	v, err := eval(e)
	if err != nil {
		return 0, err
	}
	return v, nil
}

func eval(e Expr) (int64, *EvalError) {
	switch n := e.(type) {
	case *Const:
		return n.Val, nil
	case *Cond:
		c, err := eval(n.C)
		if err != nil {
			return 0, err
		}
		if c != 0 {
			return eval(n.T)
		}
		return eval(n.F)
	case *Binary:
		l, err := eval(n.L)
		if err != nil {
			return 0, err
		}
		switch n.Op {
		case OpAnd:
			if l == 0 {
				return 0, nil
			}
			r, err := eval(n.R)
			if err != nil {
				return 0, err
			}
			return b2i(r != 0), nil
		case OpOr:
			if l != 0 {
				return 1, nil
			}
			r, err := eval(n.R)
			if err != nil {
				return 0, err
			}
			return b2i(r != 0), nil
		}
		r, err := eval(n.R)
		if err != nil {
			return 0, err
		}
		switch n.Op {
		case OpAdd:
			return l + r, nil
		case OpSub:
			return l - r, nil
		case OpMul:
			return l * r, nil
		case OpDiv:
			if r == 0 {
				return 0, &EvalError{At: n.At, Msg: "integer divide by zero"}
			}
			return l / r, nil
		case OpMod:
			if r == 0 {
				return 0, &EvalError{At: n.At, Msg: "integer divide by zero"}
			}
			return l % r, nil
		case OpEq:
			return b2i(l == r), nil
		case OpNe:
			return b2i(l != r), nil
		case OpLt:
			return b2i(l < r), nil
		case OpLe:
			return b2i(l <= r), nil
		case OpGt:
			return b2i(l > r), nil
		case OpGe:
			return b2i(l >= r), nil
		}
	}
	panic("unreachable")
}

// Result is the outcome of evaluating one expression in a Program.
type Result struct {
	Val int64
	Err *EvalError
}

// EvalProgram evaluates each expression in order, recording one Result per
// expression, so the observable sequence of errors can be inspected.
func EvalProgram(exprs []Expr) []Result {
	out := make([]Result, len(exprs))
	for i, e := range exprs {
		v, err := eval(e)
		out[i] = Result{Val: v, Err: err}
	}
	return out
}

func b2i(b bool) int64 {
	if b {
		return 1
	}
	return 0
}
