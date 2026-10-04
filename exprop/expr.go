// Package exprop provides a small integer-expression optimizer that performs
// constant folding and short-circuit simplification while preserving the
// observable order of division-by-zero errors.
package exprop

import (
	"fmt"
	"strings"
)

// Pos is a source position attached to every expression node.
type Pos struct {
	Offset int
	Line   int
	Column int
}

func (p Pos) String() string { return fmt.Sprintf("%d:%d", p.Line, p.Column) }

// Op is a binary operator. And and Or are short-circuiting and yield 0 or 1.
type Op int

const (
	OpAdd Op = iota
	OpSub
	OpMul
	OpDiv
	OpMod
	OpAnd
	OpOr
	OpEq
	OpNe
	OpLt
	OpLe
	OpGt
	OpGe
)

func (o Op) String() string {
	switch o {
	case OpAdd:
		return "+"
	case OpSub:
		return "-"
	case OpMul:
		return "*"
	case OpDiv:
		return "/"
	case OpMod:
		return "%"
	case OpAnd:
		return "&&"
	case OpOr:
		return "||"
	case OpEq:
		return "=="
	case OpNe:
		return "!="
	case OpLt:
		return "<"
	case OpLe:
		return "<="
	case OpGt:
		return ">"
	case OpGe:
		return ">="
	}
	return "?"
}

// Expr is a node in the expression tree.
type Expr interface {
	Pos() Pos
	expr()
}

// Const is an integer literal.
type Const struct {
	Val int64
	At  Pos
}

// Binary is a binary operation. Its position is the operator position.
type Binary struct {
	Op   Op
	L, R Expr
	At   Pos
}

// Cond is a conditional expression c ? t : f. Only the selected branch is
// evaluated.
type Cond struct {
	C, T, F Expr
	At      Pos
}

func (c *Const) Pos() Pos  { return c.At }
func (b *Binary) Pos() Pos { return b.At }
func (c *Cond) Pos() Pos   { return c.At }

func (*Const) expr()  {}
func (*Binary) expr() {}
func (*Cond) expr()   {}

// Dump renders the tree as an S-expression annotated with source positions.
func Dump(e Expr) string {
	var sb strings.Builder
	dump(&sb, e)
	return sb.String()
}

func dump(sb *strings.Builder, e Expr) {
	switch n := e.(type) {
	case *Const:
		fmt.Fprintf(sb, "%d@%s", n.Val, n.At)
	case *Binary:
		fmt.Fprintf(sb, "(%s@%s ", n.Op, n.At)
		dump(sb, n.L)
		sb.WriteByte(' ')
		dump(sb, n.R)
		sb.WriteByte(')')
	case *Cond:
		fmt.Fprintf(sb, "(?:@%s ", n.At)
		dump(sb, n.C)
		sb.WriteByte(' ')
		dump(sb, n.T)
		sb.WriteByte(' ')
		dump(sb, n.F)
		sb.WriteByte(')')
	}
}
