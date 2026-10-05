package expropt

import "fmt"

// DivZeroError is the only observable runtime error. At is the source
// offset of the offending '/' operator.
type DivZeroError struct {
	At int
}

func (e *DivZeroError) Error() string {
	return fmt.Sprintf("division by zero at offset %d", e.At)
}

// Eval interprets n left-to-right with short-circuit && and ||.
func Eval(n Node) (int64, error) {
	switch n := n.(type) {
	case *Const:
		return n.Val, nil
	case *Truthy:
		v, err := Eval(n.X)
		if err != nil {
			return 0, err
		}
		if v != 0 {
			return 1, nil
		}
		return 0, nil
	case *Binary:
		l, err := Eval(n.L)
		if err != nil {
			return 0, err
		}
		switch n.Op {
		case And:
			if l == 0 {
				return 0, nil // R is never evaluated
			}
			r, err := Eval(n.R)
			if err != nil {
				return 0, err
			}
			if r != 0 {
				return 1, nil
			}
			return 0, nil
		case Or:
			if l != 0 {
				return 1, nil // R is never evaluated
			}
			r, err := Eval(n.R)
			if err != nil {
				return 0, err
			}
			if r != 0 {
				return 1, nil
			}
			return 0, nil
		}
		r, err := Eval(n.R)
		if err != nil {
			return 0, err
		}
		switch n.Op {
		case Add:
			return l + r, nil
		case Sub:
			return l - r, nil
		case Mul:
			return l * r, nil
		case Div:
			if r == 0 {
				return 0, &DivZeroError{At: n.At}
			}
			return l / r, nil
		case Eq:
			return b2i(l == r), nil
		case Ne:
			return b2i(l != r), nil
		case Lt:
			return b2i(l < r), nil
		case Le:
			return b2i(l <= r), nil
		case Gt:
			return b2i(l > r), nil
		case Ge:
			return b2i(l >= r), nil
		}
	}
	return 0, fmt.Errorf("unknown node %T", n)
}

func b2i(b bool) int64 {
	if b {
		return 1
	}
	return 0
}
