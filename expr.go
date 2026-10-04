package rint

import (
	"fmt"
	"math/big"
)

// Op 是表达式结点类型。
type Op int

const (
	OpConst Op = iota // 常量，Val 有效
	OpVar             // 变量，Var 为下标
	OpAdd             // Args[0] + Args[1]
	OpSub             // Args[0] - Args[1]
	OpMul             // Args[0] * Args[1]
	OpDiv             // Args[0] / Args[1]
	OpIf              // Args[0] > 0 ? Args[1] : Args[2]
)

// Expr 是表达式树。用包级构造函数创建。
type Expr struct {
	Op   Op
	Val  *big.Rat // OpConst
	Var  int      // OpVar
	Args []*Expr
}

// ConstE 构造常量表达式。
func ConstE(v *big.Rat) *Expr { return &Expr{Op: OpConst, Val: new(big.Rat).Set(v)} }

// ConstIntE 构造整常量表达式。
func ConstIntE(v int64) *Expr { return ConstE(big.NewRat(v, 1)) }

// VarE 构造第 i 个变量。
func VarE(i int) *Expr { return &Expr{Op: OpVar, Var: i} }

// AddE / SubE / MulE / DivE 构造二元运算表达式。
func AddE(a, b *Expr) *Expr { return &Expr{Op: OpAdd, Args: []*Expr{a, b}} }
func SubE(a, b *Expr) *Expr { return &Expr{Op: OpSub, Args: []*Expr{a, b}} }
func MulE(a, b *Expr) *Expr { return &Expr{Op: OpMul, Args: []*Expr{a, b}} }
func DivE(a, b *Expr) *Expr { return &Expr{Op: OpDiv, Args: []*Expr{a, b}} }

// IfE 构造分支表达式：cond > 0 时取 thenE，否则取 elseE。
func IfE(cond, thenE, elseE *Expr) *Expr {
	return &Expr{Op: OpIf, Args: []*Expr{cond, thenE, elseE}}
}

// NumVars 返回表达式引用的最大变量下标 + 1。
func (e *Expr) NumVars() int {
	switch e.Op {
	case OpConst:
		return 0
	case OpVar:
		return e.Var + 1
	}
	n := 0
	for _, a := range e.Args {
		if m := a.NumVars(); m > n {
			n = m
		}
	}
	return n
}

// EvalInterval 用朴素区间算术求值。共享变量的多次出现被当作独立
// 区间，因此结果是值域的外包（可能高估），不是精确最值。
// 除以含 0 区间或任何子表达式无定义时返回无定义。
func (e *Expr) EvalInterval(env []Interval) Interval {
	switch e.Op {
	case OpConst:
		return Const(e.Val)
	case OpVar:
		return env[e.Var]
	case OpAdd:
		return Add(e.Args[0].EvalInterval(env), e.Args[1].EvalInterval(env))
	case OpSub:
		return Sub(e.Args[0].EvalInterval(env), e.Args[1].EvalInterval(env))
	case OpMul:
		return Mul(e.Args[0].EvalInterval(env), e.Args[1].EvalInterval(env))
	case OpDiv:
		return Div(e.Args[0].EvalInterval(env), e.Args[1].EvalInterval(env))
	case OpIf:
		cond := e.Args[0].EvalInterval(env)
		if cond.Undef {
			return Undefined()
		}
		thenI := e.Args[1].EvalInterval(env)
		elseI := e.Args[2].EvalInterval(env)
		switch {
		case cond.Lo.Sign() > 0: // 恒真
			return thenI
		case cond.Hi.Sign() <= 0: // 恒假
			return elseI
		default: // 条件跨 0：两分支都可能，取包络
			if thenI.Undef || elseI.Undef {
				return Undefined()
			}
			return Hull(thenI, elseI)
		}
	}
	panic("rint: 未知运算符")
}

// EvalPoint 在网格点上精确求值。ok=false 表示该点无定义
// （除以 0 或子表达式无定义）。
func (e *Expr) EvalPoint(env []*big.Rat) (v *big.Rat, ok bool) {
	switch e.Op {
	case OpConst:
		return new(big.Rat).Set(e.Val), true
	case OpVar:
		return new(big.Rat).Set(env[e.Var]), true
	case OpIf:
		cond, ok := e.Args[0].EvalPoint(env)
		if !ok {
			return nil, false
		}
		if cond.Sign() > 0 {
			return e.Args[1].EvalPoint(env)
		}
		return e.Args[2].EvalPoint(env)
	}
	a, ok := e.Args[0].EvalPoint(env)
	if !ok {
		return nil, false
	}
	b, ok := e.Args[1].EvalPoint(env)
	if !ok {
		return nil, false
	}
	switch e.Op {
	case OpAdd:
		return a.Add(a, b), true
	case OpSub:
		return a.Sub(a, b), true
	case OpMul:
		return a.Mul(a, b), true
	case OpDiv:
		if b.Sign() == 0 {
			return nil, false
		}
		return a.Quo(a, b), true
	}
	panic("rint: 未知运算符")
}

func (e *Expr) String() string {
	switch e.Op {
	case OpConst:
		return e.Val.RatString()
	case OpVar:
		return fmt.Sprintf("x%d", e.Var)
	case OpIf:
		return fmt.Sprintf("if(%v>0, %v, %v)", e.Args[0], e.Args[1], e.Args[2])
	}
	names := map[Op]string{OpAdd: "+", OpSub: "-", OpMul: "*", OpDiv: "/"}
	return fmt.Sprintf("(%v %s %v)", e.Args[0], names[e.Op], e.Args[1])
}
