package dataeng

import "fmt"

// TermKind distinguishes variables from constants in a query term.
type TermKind uint8

const (
	// VariableTerm denotes a variable scoped to the query that contains it.
	VariableTerm TermKind = iota
	// ConstantTerm denotes a UTF-8 constant. Constants are equal exactly when
	// their byte strings are equal.
	ConstantTerm
)

// Term is either a query variable or a constant.
//
// Variable names are scoped to the query in which they occur. A variable in
// query A and a variable with the same label in query B are different symbols.
type Term struct {
	Kind TermKind
	Name string
}

// Var constructs a variable term.
func Var(name string) Term {
	return Term{Kind: VariableTerm, Name: name}
}

// Const constructs a constant term.
func Const(value string) Term {
	return Term{Kind: ConstantTerm, Name: value}
}

// IsVariable reports whether t is a variable.
func (t Term) IsVariable() bool {
	return t.Kind == VariableTerm
}

// IsConstant reports whether t is a constant.
func (t Term) IsConstant() bool {
	return t.Kind == ConstantTerm
}

func (t Term) String() string {
	if t.Kind == ConstantTerm {
		return fmt.Sprintf("const(%q)", t.Name)
	}
	if t.Kind == VariableTerm {
		return "var(" + t.Name + ")"
	}
	return fmt.Sprintf("term(kind=%d,name=%q)", t.Kind, t.Name)
}
