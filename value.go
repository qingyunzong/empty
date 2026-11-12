package dataeng

import (
	"fmt"
	"strconv"
)

// ValueKind distinguishes user constants from fresh counterexample symbols.
type ValueKind uint8

const (
	// ValueConstant is a user constant.
	ValueConstant ValueKind = iota
	// ValueFresh is a typed fresh symbol generated for a counterexample.
	ValueFresh
)

// Value is a database value.
//
// User constants and fresh symbols are different kinds. In particular, a fresh
// symbol is never equal to a user constant with the same textual spelling.
// Fields are unexported so callers cannot construct inconsistent values.
type Value struct {
	kind    ValueKind
	text    string
	freshID int
}

// ConstantValue constructs a user-constant value.
func ConstantValue(text string) Value {
	return Value{kind: ValueConstant, text: text}
}

// FreshValue constructs a typed fresh symbol. The ID is local to a generated
// counterexample and is not part of the user-visible constant domain.
func FreshValue(id int) Value {
	return Value{kind: ValueFresh, freshID: id}
}

// Kind reports the value kind.
func (v Value) Kind() ValueKind {
	return v.kind
}

// Text returns the user-constant bytes and whether v is a user constant.
func (v Value) Text() (string, bool) {
	if v.kind != ValueConstant {
		return "", false
	}
	return v.text, true
}

// FreshID returns the fresh-symbol ID and whether v is a fresh symbol.
func (v Value) FreshID() (int, bool) {
	if v.kind != ValueFresh {
		return 0, false
	}
	return v.freshID, true
}

// IsConstant reports whether v is a user constant.
func (v Value) IsConstant() bool {
	return v.kind == ValueConstant
}

// IsFresh reports whether v is a fresh symbol.
func (v Value) IsFresh() bool {
	return v.kind == ValueFresh
}

func (v Value) valid() bool {
	return v.kind == ValueConstant || v.kind == ValueFresh
}

func (v Value) String() string {
	switch v.kind {
	case ValueConstant:
		return "const(" + strconv.Quote(v.text) + ")"
	case ValueFresh:
		return fmt.Sprintf("fresh#%d", v.freshID)
	default:
		return fmt.Sprintf("value(kind=%d,text=%q,fresh=%d)", v.kind, v.text, v.freshID)
	}
}
