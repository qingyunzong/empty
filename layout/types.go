// Package layout computes byte layouts for struct-like types:
// field offsets aligned upward to each field's alignment, tail
// padding up to the struct's maximum alignment, with support for
// nested structs, fixed-size arrays and named type references.
package layout

import (
	"fmt"
	"strings"
)

// Kind discriminates the shape of a Type.
type Kind int

const (
	// Int is a plain integer of Size bytes; its alignment equals Size.
	Int Kind = iota
	// Struct is an ordered list of named fields.
	Struct
	// Array is Count elements of Elem laid out contiguously.
	Array
	// Ref refers to a named type resolved through an Env.
	Ref
)

// Type describes a value type. Only the fields relevant to its Kind
// are meaningful.
type Type struct {
	Kind   Kind
	Size   uint64 // Int: size in bytes, must be a power of two
	Name   string // Ref: name looked up in the Env
	Fields []Field
	Elem   *Type // Array: element type
	Count  uint64
}

// Field is one named member of a Struct.
type Field struct {
	Name string
	Type Type
}

// Env maps type names to their definitions for Ref resolution.
type Env map[string]Type

// IntOf is a helper building an Int type of n bytes.
func IntOf(n uint64) Type { return Type{Kind: Int, Size: n} }

// StructOf is a helper building a Struct type.
func StructOf(fields ...Field) Type { return Type{Kind: Struct, Fields: fields} }

// F is a helper building a Field.
func F(name string, t Type) Field { return Field{Name: name, Type: t} }

// ArrayOf is a helper building a fixed-size Array type.
func ArrayOf(elem Type, count uint64) Type { return Type{Kind: Array, Elem: &elem, Count: count} }

// RefOf is a helper building a named type reference.
func RefOf(name string) Type { return Type{Kind: Ref, Name: name} }

// CycleError reports a recursive value type. Chain lists the type
// names from the first occurrence through the repeated one, e.g.
// ["A", "B", "A"].
type CycleError struct {
	Chain []string
}

func (e *CycleError) Error() string {
	return fmt.Sprintf("recursive value type: %s", strings.Join(e.Chain, " -> "))
}

// OverflowError reports that a size or offset computation exceeded
// uint64; no layout is published in that case.
type OverflowError struct {
	What string
}

func (e *OverflowError) Error() string {
	return fmt.Sprintf("layout overflow: %s", e.What)
}
