// Package dagmetrics implements a DAG of derived metrics whose expressions
// use only integer addition, subtraction, multiplication and conditionals.
// Input corrections trigger incremental recomputation of only the actually
// affected dependency closure, and multiple source updates in one batch are
// published atomically under a single new version.
package dagmetrics

import "fmt"

// Op is the operator of an expression node.
type Op int

const (
	OpConst Op = iota // integer constant
	OpRef             // reference to another metric by name
	OpAdd             // Args[0] + Args[1]
	OpSub             // Args[0] - Args[1]
	OpMul             // Args[0] * Args[1]
	OpCond            // Args[0] != 0 ? Args[1] : Args[2]
)

// Expr is an immutable expression tree.
type Expr struct {
	Op    Op
	Value int64  // OpConst
	Ref   string // OpRef
	Args  []*Expr
}

func Const(v int64) *Expr      { return &Expr{Op: OpConst, Value: v} }
func Ref(name string) *Expr    { return &Expr{Op: OpRef, Ref: name} }
func Add(a, b *Expr) *Expr     { return &Expr{Op: OpAdd, Args: []*Expr{a, b}} }
func Sub(a, b *Expr) *Expr     { return &Expr{Op: OpSub, Args: []*Expr{a, b}} }
func Mul(a, b *Expr) *Expr     { return &Expr{Op: OpMul, Args: []*Expr{a, b}} }
func Cond(c, t, f *Expr) *Expr { return &Expr{Op: OpCond, Args: []*Expr{c, t, f}} }

// eval computes the expression against env, which must contain every
// referenced metric.
func (e *Expr) eval(env map[string]int64) (int64, error) {
	switch e.Op {
	case OpConst:
		return e.Value, nil
	case OpRef:
		v, ok := env[e.Ref]
		if !ok {
			return 0, fmt.Errorf("unknown metric %q", e.Ref)
		}
		return v, nil
	case OpAdd:
		a, err := e.Args[0].eval(env)
		if err != nil {
			return 0, err
		}
		b, err := e.Args[1].eval(env)
		if err != nil {
			return 0, err
		}
		return a + b, nil
	case OpSub:
		a, err := e.Args[0].eval(env)
		if err != nil {
			return 0, err
		}
		b, err := e.Args[1].eval(env)
		if err != nil {
			return 0, err
		}
		return a - b, nil
	case OpMul:
		a, err := e.Args[0].eval(env)
		if err != nil {
			return 0, err
		}
		b, err := e.Args[1].eval(env)
		if err != nil {
			return 0, err
		}
		return a * b, nil
	case OpCond:
		c, err := e.Args[0].eval(env)
		if err != nil {
			return 0, err
		}
		if c != 0 {
			return e.Args[1].eval(env)
		}
		return e.Args[2].eval(env)
	}
	return 0, fmt.Errorf("bad op %d", e.Op)
}

// refs collects the names of all metrics referenced by the expression.
func (e *Expr) refs(out map[string]bool) {
	switch e.Op {
	case OpRef:
		out[e.Ref] = true
	default:
		for _, a := range e.Args {
			a.refs(out)
		}
	}
}
