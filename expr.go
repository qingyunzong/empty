// Package intfold parses, evaluates and constant-folds 32-bit wraparound
// integer expressions with short-circuit semantics.
//
// Rules honored by the folder:
//   - Division/modulo by zero inside a branch that is short-circuited away
//     is discarded silently and never promoted to a compile-time error.
//   - A constant division/modulo by zero that must execute is folded to a
//     TrapNode, which traps at run time with the original source span.
//   - All arithmetic wraps around at 32 bits (two's complement), including
//     MinInt32 / -1 and negation of MinInt32.
package intfold

import (
	"fmt"
	"strings"
)

// Span is a byte-offset range [Lo, Hi) into the source string.
type Span struct {
	Lo, Hi int
}

func (s Span) String() string { return fmt.Sprintf("%d:%d", s.Lo, s.Hi) }

type Kind int

const (
	Const Kind = iota
	Var
	Binary
	Unary
	Cond
	// TrapNode is produced only by Fold: a must-execute constant
	// division/modulo by zero. Evaluating it yields a *Trap.
	TrapNode
)

func (k Kind) String() string {
	switch k {
	case Const:
		return "const"
	case Var:
		return "var"
	case Binary:
		return "binary"
	case Unary:
		return "unary"
	case Cond:
		return "cond"
	case TrapNode:
		return "trap"
	}
	return "?"
}

type Op int

const (
	OpAdd Op = iota
	OpSub
	OpMul
	OpDiv
	OpMod
	OpEq
	OpNe
	OpLt
	OpLe
	OpGt
	OpGe
	OpAnd
	OpOr
	OpNeg // unary
	OpNot // unary
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
	case OpAnd:
		return "&&"
	case OpOr:
		return "||"
	case OpNeg:
		return "neg"
	case OpNot:
		return "!"
	}
	return "?"
}

// Expr is a node of the expression AST. Prov accumulates provenance notes
// during folding (what rewrite happened, from which source span).
type Expr struct {
	Kind Kind
	Span Span
	Op   Op

	Val  int32  // Const
	Name string // Var
	Msg  string // TrapNode

	L, R    *Expr // Binary
	X       *Expr // Unary
	C, T, F *Expr // Cond

	Prov []string
}

func (e *Expr) note(format string, args ...any) {
	e.Prov = append(e.Prov, fmt.Sprintf(format, args...))
}

// Dump renders the AST as an indented tree including source spans and
// provenance notes.
func Dump(e *Expr) string {
	var sb strings.Builder
	dump(&sb, e, "", true)
	return sb.String()
}

func dump(sb *strings.Builder, e *Expr, prefix string, last bool) {
	branch := "`- "
	childPrefix := prefix + "   "
	if !last {
		branch = "|- "
		childPrefix = prefix + "|  "
	}
	fmt.Fprintf(sb, "%s%s%s [%s]", prefix, branch, nodeLabel(e), e.Span)
	for _, p := range e.Prov {
		fmt.Fprintf(sb, "\n%s# %s", childPrefix, p)
	}
	sb.WriteByte('\n')
	kids := children(e)
	for i, k := range kids {
		dump(sb, k, childPrefix, i == len(kids)-1)
	}
}

func nodeLabel(e *Expr) string {
	switch e.Kind {
	case Const:
		return fmt.Sprintf("const %d", e.Val)
	case Var:
		return "var " + e.Name
	case Binary:
		return "binary " + e.Op.String()
	case Unary:
		return "unary " + e.Op.String()
	case Cond:
		return "cond ?:"
	case TrapNode:
		return "TRAP " + e.Msg
	}
	return "?"
}

func children(e *Expr) []*Expr {
	switch e.Kind {
	case Binary:
		return []*Expr{e.L, e.R}
	case Unary:
		return []*Expr{e.X}
	case Cond:
		return []*Expr{e.C, e.T, e.F}
	}
	return nil
}
