package interp

// Kind enumerates AST node kinds. A single struct is used for all nodes so
// that programs are trivially serializable with encoding/json.
type Kind int

const (
	KNil Kind = iota
	KBool
	KInt
	KStr
	KSym
	KIf
	KBegin
	KLambda
	KCall
	KTry
	KThrow
)

// Node is a universal AST node. Unused fields stay zero.
type Node struct {
	Kind Kind

	// Literals and symbols.
	Num int64
	Str string
	Sym string

	// If.
	Cond *Node
	Then *Node
	Else *Node

	// Lambda.
	Name   string   // optional self-name for recursion
	Params []string // also let/letrec bound names after desugaring
	Body   []*Node  // lambda/begin/try body

	// Call.
	Func *Node
	Args []*Node

	// Try.
	HasCatch   bool
	CatchParam string
	Catch      []*Node
	HasFinal   bool
	Final      []*Node

	// Throw operand.
	Sub *Node
}
