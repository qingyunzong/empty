// Package expropt implements a small integer-expression language with an
// interpreter and a semantics-preserving optimizer (constant folding and
// short-circuit simplification).
//
// Observable behavior contract: the only observable effect besides the
// final value is a division-by-zero error. Evaluation is left-to-right and
// && / || short-circuit. The optimizer must preserve the value and the
// identity (position) of the first division-by-zero error, and must never
// turn a runtime error into a compile-time one.
package expropt

// Op is a binary operator.
type Op int

const (
	Add Op = iota
	Sub
	Mul
	Div
	Eq
	Ne
	Lt
	Le
	Gt
	Ge
	And // logical, short-circuit, result 0/1
	Or  // logical, short-circuit, result 0/1
)

func (o Op) String() string {
	switch o {
	case Add:
		return "+"
	case Sub:
		return "-"
	case Mul:
		return "*"
	case Div:
		return "/"
	case Eq:
		return "=="
	case Ne:
		return "!="
	case Lt:
		return "<"
	case Le:
		return "<="
	case Gt:
		return ">"
	case Ge:
		return ">="
	case And:
		return "&&"
	case Or:
		return "||"
	}
	return "?"
}

// Node is an expression AST node. Pos is the byte offset of the construct
// in the source string it was parsed from (or a synthetic offset for
// generated trees).
type Node interface {
	Pos() int
}

// Const is an integer literal.
type Const struct {
	Val int64
	At  int
}

func (c *Const) Pos() int { return c.At }

// Binary is a binary operation. For Div, And and Or the position is the
// operator offset, which is what a DivZeroError reports.
type Binary struct {
	Op   Op
	L, R Node
	At   int
}

func (b *Binary) Pos() int { return b.At }

// Truthy normalizes a value to 0/1. It is introduced by the optimizer when
// a short-circuit operator's left operand is a known constant; it never
// appears in parsed source.
type Truthy struct {
	X  Node
	At int
}

func (t *Truthy) Pos() int { return t.At }
