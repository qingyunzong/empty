package dataeng

import (
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"
)

// Kind identifies the operation represented by an Expr.
type Kind uint8

const (
	KindInvalid Kind = iota
	KindVar
	KindUnion
	KindJoin
	KindZero
	KindOne
)

// Expr is a node in a shared expression DAG.
//
// A variable node represents a base row. A union node is polynomial addition,
// and a join node is polynomial multiplication. Children are shared by
// pointer: evaluating the same *Expr twice reuses the first result.
//
// Expr values are immutable after construction. Use the constructors in this
// package rather than creating Expr values directly.
type Expr struct {
	kind Kind
	id   string
	args []*Expr
}

// ValidateVariableID checks that id is a non-empty, valid UTF-8 string.
func ValidateVariableID(id string) error {
	if id == "" {
		return ErrEmptyVariableID
	}
	if !utf8.ValidString(id) {
		return ErrInvalidUTF8
	}
	return nil
}

// NewVar creates a variable node. It returns ErrEmptyVariableID or
// ErrInvalidUTF8 for an invalid ID.
func NewVar(id string) (*Expr, error) {
	if err := ValidateVariableID(id); err != nil {
		return nil, err
	}
	return &Expr{kind: KindVar, id: id}, nil
}

// Var creates a variable node and panics if id is empty or invalid UTF-8.
// Use NewVar if the ID comes from untrusted input.
func Var(id string) *Expr {
	e, err := NewVar(id)
	if err != nil {
		panic(err)
	}
	return e
}

// MustVar is an alias for Var.
func MustVar(id string) *Expr {
	return Var(id)
}

// Variable is an alias for Var.
func Variable(id string) *Expr {
	return Var(id)
}

// Zero returns the zero polynomial expression.
func Zero() *Expr {
	return &Expr{kind: KindZero}
}

// One returns the constant polynomial 1.
func One() *Expr {
	return &Expr{kind: KindOne}
}

// Union creates a polynomial sum. Union() is zero, and union nodes containing
// zero are simplified. Union(x) returns x itself.
func Union(parts ...*Expr) *Expr {
	e, err := NewUnion(parts...)
	if err != nil {
		panic(err)
	}
	return e
}

// NewUnion is the error-returning form of Union.
func NewUnion(parts ...*Expr) (*Expr, error) {
	args := make([]*Expr, 0, len(parts))
	for _, part := range parts {
		if part == nil {
			return nil, ErrNilExpression
		}
		if part.kind != KindZero {
			args = append(args, part)
		}
	}
	switch len(args) {
	case 0:
		return Zero(), nil
	case 1:
		return args[0], nil
	default:
		return &Expr{kind: KindUnion, args: args}, nil
	}
}

// Add is an alias for Union.
func Add(a, b *Expr) *Expr {
	return Union(a, b)
}

// Sum is an alias for Union.
func Sum(parts ...*Expr) *Expr {
	return Union(parts...)
}

// UnionAll creates a union from a slice of expressions.
func UnionAll(parts []*Expr) *Expr {
	return Union(parts...)
}

// Join creates a polynomial product. Join() is one. Products containing zero
// are simplified to zero, and products containing one are simplified away.
// Join(x) returns x itself.
func Join(parts ...*Expr) *Expr {
	e, err := NewJoin(parts...)
	if err != nil {
		panic(err)
	}
	return e
}

// NewJoin is the error-returning form of Join.
func NewJoin(parts ...*Expr) (*Expr, error) {
	args := make([]*Expr, 0, len(parts))
	for _, part := range parts {
		if part == nil {
			return nil, ErrNilExpression
		}
		switch part.kind {
		case KindZero:
			return Zero(), nil
		case KindOne:
			// Multiplicative identity.
		default:
			args = append(args, part)
		}
	}
	switch len(args) {
	case 0:
		return One(), nil
	case 1:
		return args[0], nil
	default:
		return &Expr{kind: KindJoin, args: args}, nil
	}
}

// Multiply is an alias for Join.
func Multiply(a, b *Expr) *Expr {
	return Join(a, b)
}

// Product is an alias for Join.
func Product(parts ...*Expr) *Expr {
	return Join(parts...)
}

// JoinAll creates a join from a slice of expressions.
func JoinAll(parts []*Expr) *Expr {
	return Join(parts...)
}

// Kind returns the node kind.
func (e *Expr) Kind() Kind {
	if e == nil {
		return KindInvalid
	}
	return e.kind
}

// VariableID returns the ID for a variable node and the empty string for
// other node kinds.
func (e *Expr) VariableID() string {
	if e == nil || e.kind != KindVar {
		return ""
	}
	return e.id
}

// ID is an alias for VariableID.
func (e *Expr) ID() string {
	return e.VariableID()
}

// Children returns a copy of the node's children.
func (e *Expr) Children() []*Expr {
	if e == nil {
		return nil
	}
	return append([]*Expr(nil), e.args...)
}

// Arity returns the number of child expressions.
func (e *Expr) Arity() int {
	if e == nil {
		return 0
	}
	return len(e.args)
}

// String renders the expression for debugging. Variable IDs are quoted so
// that IDs containing punctuation remain visible.
func (e *Expr) String() string {
	return formatExpr(e, map[*Expr]bool{})
}

func formatExpr(e *Expr, seen map[*Expr]bool) string {
	if e == nil {
		return "<nil>"
	}
	if seen[e] {
		return "<shared>"
	}
	switch e.kind {
	case KindVar:
		return fmt.Sprintf("var(%q)", e.id)
	case KindZero:
		return "zero"
	case KindOne:
		return "one"
	case KindUnion:
		seen[e] = true
		parts := make([]string, len(e.args))
		for i, arg := range e.args {
			parts[i] = formatExpr(arg, seen)
		}
		return "union(" + strings.Join(parts, ", ") + ")"
	case KindJoin:
		seen[e] = true
		parts := make([]string, len(e.args))
		for i, arg := range e.args {
			parts[i] = formatExpr(arg, seen)
		}
		return "join(" + strings.Join(parts, ", ") + ")"
	default:
		return "<invalid>"
	}
}

// SortVariableIDs sorts variable IDs by their UTF-8 byte representation.
func SortVariableIDs(ids []string) {
	sort.Strings(ids)
}
