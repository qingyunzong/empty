// Package layout computes byte offsets for struct-like types built from
// fixed-width integers, nested structs and fixed-length arrays.
//
// Offsets are aligned upward to each field's alignment, and the total size
// is padded at the tail to a multiple of the struct's maximum alignment.
// Recursive value types are rejected with the full containment chain, and
// any size/offset overflow aborts computation without publishing a layout.
package layout

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

// Kind discriminates the three type forms understood by the package.
type Kind int

const (
	IntKind Kind = iota
	StructKind
	ArrayKind
)

// Field is one named member of a struct type.
type Field struct {
	Name string
	Type *Type
}

// Type describes an integer, struct or fixed-length array type.
type Type struct {
	Name   string  // struct type name, used in recursion chains
	Kind   Kind    // which form this type takes
	Bits   int64   // IntKind: width in bits (8, 16, 32, 64)
	Fields []Field // StructKind: member fields in declaration order
	Elem   *Type   // ArrayKind: element type
	Count  int64   // ArrayKind: element count
}

// Int returns an integer type of the given bit width.
func Int(bits int64) *Type { return &Type{Kind: IntKind, Bits: bits} }

// Struct returns a named struct type with the given fields.
func Struct(name string, fields ...Field) *Type {
	return &Type{Kind: StructKind, Name: name, Fields: fields}
}

// Array returns a fixed-length array type of count elements.
func Array(elem *Type, count int64) *Type {
	return &Type{Kind: ArrayKind, Elem: elem, Count: count}
}

// F is a shorthand for building a struct field.
func F(name string, t *Type) Field { return Field{Name: name, Type: t} }

// FieldLayout records where one field lands inside its struct.
type FieldLayout struct {
	Name   string
	Offset int64
	Size   int64
	Align  int64
}

// Layout is the computed placement of a type: total size, alignment and,
// for structs, the offset of every field.
type Layout struct {
	Size   int64
	Align  int64
	Fields []FieldLayout
}

// ErrOverflow reports that a size or offset exceeded int64 range.
var ErrOverflow = errors.New("layout: size or offset overflow")

// RecursionError reports a struct that (transitively) contains itself by
// value. Chain lists the containment path, e.g. [A B A].
type RecursionError struct {
	Chain []string
}

func (e *RecursionError) Error() string {
	return "layout: recursive value type: " + strings.Join(e.Chain, " -> ")
}

// Computer lays out types, caching successful struct layouts. A layout is
// only published to the cache once it is fully computed without error, so
// overflows and recursion never leave partial results behind.
type Computer struct {
	cache map[*Type]*Layout
	stack []*Type
}

// NewComputer returns a ready-to-use Computer.
func NewComputer() *Computer {
	return &Computer{cache: make(map[*Type]*Layout)}
}

// Compute lays out t using a fresh Computer.
func Compute(t *Type) (Layout, error) {
	return NewComputer().Layout(t)
}

// Layout returns the layout of t, computing and caching it if needed.
func (c *Computer) Layout(t *Type) (Layout, error) {
	if t == nil {
		return Layout{}, errors.New("layout: nil type")
	}
	if l, ok := c.cache[t]; ok {
		return *l, nil
	}
	l, err := c.compute(t)
	if err != nil {
		return Layout{}, err
	}
	c.cache[t] = &l
	return l, nil
}

func (c *Computer) compute(t *Type) (Layout, error) {
	switch t.Kind {
	case IntKind:
		switch t.Bits {
		case 8, 16, 32, 64:
		default:
			return Layout{}, fmt.Errorf("layout: unsupported int width %d", t.Bits)
		}
		size := t.Bits / 8
		return Layout{Size: size, Align: size}, nil

	case ArrayKind:
		if t.Count < 0 {
			return Layout{}, fmt.Errorf("layout: negative array count %d", t.Count)
		}
		elem, err := c.Layout(t.Elem)
		if err != nil {
			return Layout{}, err
		}
		size, err := mul(elem.Size, t.Count)
		if err != nil {
			return Layout{}, err
		}
		return Layout{Size: size, Align: elem.Align}, nil

	case StructKind:
		for i, open := range c.stack {
			if open == t {
				chain := make([]string, 0, len(c.stack)-i+1)
				for _, s := range c.stack[i:] {
					chain = append(chain, typeName(s))
				}
				chain = append(chain, typeName(t))
				return Layout{}, &RecursionError{Chain: chain}
			}
		}
		c.stack = append(c.stack, t)
		defer func() { c.stack = c.stack[:len(c.stack)-1] }()

		offset := int64(0)
		maxAlign := int64(1)
		fields := make([]FieldLayout, 0, len(t.Fields))
		for _, f := range t.Fields {
			fl, err := c.Layout(f.Type)
			if err != nil {
				return Layout{}, err
			}
			offset, err = alignUp(offset, fl.Align)
			if err != nil {
				return Layout{}, err
			}
			fields = append(fields, FieldLayout{
				Name:   f.Name,
				Offset: offset,
				Size:   fl.Size,
				Align:  fl.Align,
			})
			offset, err = add(offset, fl.Size)
			if err != nil {
				return Layout{}, err
			}
			if fl.Align > maxAlign {
				maxAlign = fl.Align
			}
		}
		size, err := alignUp(offset, maxAlign)
		if err != nil {
			return Layout{}, err
		}
		return Layout{Size: size, Align: maxAlign, Fields: fields}, nil

	default:
		return Layout{}, fmt.Errorf("layout: unknown type kind %d", t.Kind)
	}
}

func typeName(t *Type) string {
	if t.Name == "" {
		return "(anon)"
	}
	return t.Name
}

func alignUp(offset, align int64) (int64, error) {
	if align <= 0 {
		return 0, ErrOverflow
	}
	rem := offset % align
	if rem == 0 {
		return offset, nil
	}
	return add(offset, align-rem)
}

func add(a, b int64) (int64, error) {
	if a < 0 || b < 0 || a > math.MaxInt64-b {
		return 0, ErrOverflow
	}
	return a + b, nil
}

func mul(a, b int64) (int64, error) {
	if a < 0 || b < 0 || (a != 0 && b > math.MaxInt64/a) {
		return 0, ErrOverflow
	}
	return a * b, nil
}
