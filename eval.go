package intfold

import "fmt"

// Trap is a run-time fault: division/modulo by zero, an explicit TrapNode,
// or an undefined variable. Span points into the original source.
type Trap struct {
	Span Span
	Msg  string
}

func (t *Trap) Error() string {
	return fmt.Sprintf("trap at [%s]: %s", t.Span, t.Msg)
}

// Eval interprets e with 32-bit wraparound semantics. Logical and
// comparison operators yield 0/1; any non-zero value is truthy.
// && and || short-circuit; ?: evaluates only the taken branch.
// The first trap encountered in evaluation order is returned.
func Eval(e *Expr, env map[string]int32) (int32, *Trap) {
	switch e.Kind {
	case Const:
		return e.Val, nil
	case Var:
		v, ok := env[e.Name]
		if !ok {
			return 0, &Trap{Span: e.Span, Msg: "undefined variable " + e.Name}
		}
		return v, nil
	case TrapNode:
		return 0, &Trap{Span: e.Span, Msg: e.Msg}
	case Unary:
		v, tr := Eval(e.X, env)
		if tr != nil {
			return 0, tr
		}
		switch e.Op {
		case OpNeg:
			return -v, nil // wraps for MinInt32
		case OpNot:
			return boolInt(v == 0), nil
		}
	case Binary:
		return evalBinary(e, env)
	case Cond:
		c, tr := Eval(e.C, env)
		if tr != nil {
			return 0, tr
		}
		if c != 0 {
			return Eval(e.T, env)
		}
		return Eval(e.F, env)
	}
	return 0, &Trap{Span: e.Span, Msg: "corrupt node"}
}

func evalBinary(e *Expr, env map[string]int32) (int32, *Trap) {
	l, tr := Eval(e.L, env)
	if tr != nil {
		return 0, tr
	}
	switch e.Op {
	case OpAnd:
		if l == 0 {
			return 0, nil // short-circuit: R is not evaluated
		}
		r, tr := Eval(e.R, env)
		if tr != nil {
			return 0, tr
		}
		return boolInt(r != 0), nil
	case OpOr:
		if l != 0 {
			return 1, nil // short-circuit: R is not evaluated
		}
		r, tr := Eval(e.R, env)
		if tr != nil {
			return 0, tr
		}
		return boolInt(r != 0), nil
	}
	r, tr := Eval(e.R, env)
	if tr != nil {
		return 0, tr
	}
	switch e.Op {
	case OpAdd:
		return l + r, nil
	case OpSub:
		return l - r, nil
	case OpMul:
		return l * r, nil
	case OpDiv:
		if r == 0 {
			return 0, &Trap{Span: e.Span, Msg: "division by zero"}
		}
		return l / r, nil // MinInt32 / -1 wraps to MinInt32
	case OpMod:
		if r == 0 {
			return 0, &Trap{Span: e.Span, Msg: "modulo by zero"}
		}
		return l % r, nil
	case OpEq:
		return boolInt(l == r), nil
	case OpNe:
		return boolInt(l != r), nil
	case OpLt:
		return boolInt(l < r), nil
	case OpLe:
		return boolInt(l <= r), nil
	case OpGt:
		return boolInt(l > r), nil
	case OpGe:
		return boolInt(l >= r), nil
	}
	return 0, &Trap{Span: e.Span, Msg: "corrupt binary op"}
}

func boolInt(b bool) int32 {
	if b {
		return 1
	}
	return 0
}
