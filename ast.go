// Package foldexpr parses, constant-folds, and evaluates integer
// expressions with 32-bit wraparound semantics and short-circuit
// operators. Division by zero is never a compile-time error: a
// constant division by zero that lies on a mandatory execution path
// is folded into a Trap node which fails at run time, preserving the
// source position of the offending operator.
package foldexpr

import (
	"fmt"
	"strconv"
	"strings"
)

// Node is an AST node. Pos is the byte offset of the node into the
// source string it was parsed from (for Binary/Unary/Cond it is the
// offset of the operator).
type Node interface {
	Pos() int
	String() string
}

// Const is an integer literal, already wrapped to 32 bits.
type Const struct {
	P   int
	Val int32
}

// Var is a variable reference resolved against an environment.
type Var struct {
	P    int
	Name string
}

// Unary is a prefix operation: "-" (negate) or "!" (logical not).
type Unary struct {
	P  int
	Op string
	X  Node
}

// Binary is an infix operation. "&&" and "||" short-circuit and
// yield 0 or 1; "/" and "%" trap at run time on a zero divisor.
type Binary struct {
	P    int
	Op   string
	L, R Node
}

// Cond is a conditional expression C ? T : F; only the taken branch
// is evaluated.
type Cond struct {
	P       int
	C, T, F Node
}

// Trap is produced by Fold for a constant division (or remainder) by
// zero on a mandatory path. Evaluating it returns a *TrapError
// carrying the original source position.
type Trap struct {
	P      int
	Reason string
}

func (n *Const) Pos() int  { return n.P }
func (n *Var) Pos() int    { return n.P }
func (n *Unary) Pos() int  { return n.P }
func (n *Binary) Pos() int { return n.P }
func (n *Cond) Pos() int   { return n.P }
func (n *Trap) Pos() int   { return n.P }

func (n *Const) String() string  { return strconv.FormatInt(int64(n.Val), 10) }
func (n *Var) String() string    { return n.Name }
func (n *Unary) String() string  { return "(" + n.Op + n.X.String() + ")" }
func (n *Binary) String() string { return "(" + n.L.String() + " " + n.Op + " " + n.R.String() + ")" }
func (n *Cond) String() string {
	return "(" + n.C.String() + " ? " + n.T.String() + " : " + n.F.String() + ")"
}
func (n *Trap) String() string { return fmt.Sprintf("<trap@%d: %s>", n.P, n.Reason) }

// Dump renders the AST as an indented tree, one node per line, each
// annotated with its byte offset into the source.
func Dump(n Node) string {
	var sb strings.Builder
	dumpNode(&sb, n, "")
	return sb.String()
}

func dumpNode(sb *strings.Builder, n Node, indent string) {
	switch n := n.(type) {
	case *Const:
		fmt.Fprintf(sb, "%sConst(%d) @%d\n", indent, n.Val, n.P)
	case *Var:
		fmt.Fprintf(sb, "%sVar(%s) @%d\n", indent, n.Name, n.P)
	case *Trap:
		fmt.Fprintf(sb, "%sTrap(%s) @%d\n", indent, n.Reason, n.P)
	case *Unary:
		fmt.Fprintf(sb, "%sUnary(%s) @%d\n", indent, n.Op, n.P)
		dumpNode(sb, n.X, indent+"  ")
	case *Binary:
		fmt.Fprintf(sb, "%sBinary(%s) @%d\n", indent, n.Op, n.P)
		dumpNode(sb, n.L, indent+"  ")
		dumpNode(sb, n.R, indent+"  ")
	case *Cond:
		fmt.Fprintf(sb, "%sCond @%d\n", indent, n.P)
		dumpNode(sb, n.C, indent+"  ")
		dumpNode(sb, n.T, indent+"  ")
		dumpNode(sb, n.F, indent+"  ")
	}
}

// Position converts a byte offset into src into a 1-based line and
// column, for reporting trap locations against the original source.
func Position(src string, pos int) (line, col int) {
	line, col = 1, 1
	for i := 0; i < pos && i < len(src); i++ {
		if src[i] == '\n' {
			line++
			col = 1
		} else {
			col++
		}
	}
	return line, col
}
