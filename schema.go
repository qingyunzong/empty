package dataeng

import (
	"errors"
	"fmt"
	"math"
)

// Kind identifies the subset of FlatBuffers field types this reader supports.
type Kind int

const (
	KindU8 Kind = iota + 1
	KindI32
	KindI64
	KindString
	KindTable
	KindVectorU8
	KindVectorI32
	KindVectorI64
	KindVectorTable
)

// String returns the Go-style name of the kind.
func (k Kind) String() string {
	switch k {
	case KindU8:
		return "u8"
	case KindI32:
		return "i32"
	case KindI64:
		return "i64"
	case KindString:
		return "string"
	case KindTable:
		return "table"
	case KindVectorU8:
		return "vector<u8>"
	case KindVectorI32:
		return "vector<i32>"
	case KindVectorI64:
		return "vector<i64>"
	case KindVectorTable:
		return "vector<table>"
	default:
		return fmt.Sprintf("unknown(%d)", int(k))
	}
}

// Field is one compiled field definition. Slot numbers follow the schema and
// are not derived from declaration order. RefTable is required only for
// KindTable and KindVectorTable fields; it may be wired after construction to
// support recursive table types.
type Field struct {
	Name     string
	Kind     Kind
	Slot     uint16
	Default  int64
	RefTable *Table
}

// Table is a compiled table definition supplied by the host.
type Table struct {
	name     string
	fields   []*Field
	byName   map[string]*Field
	slotUsed map[uint16]bool
}

// NewTable creates a table definition and adds the given fields. Fields whose
// RefTable points to a table declared later can be added with Add instead.
func NewTable(name string, fields ...Field) (*Table, error) {
	if name == "" {
		return nil, errors.New("dataeng: table name must not be empty")
	}
	t := &Table{
		name:     name,
		byName:   map[string]*Field{},
		slotUsed: map[uint16]bool{},
	}
	for i := range fields {
		if err := t.Add(fields[i]); err != nil {
			return nil, err
		}
	}
	return t, nil
}

// Add registers a field. It allows forward references: table-typed fields may
// carry a nil RefTable until the referenced table is constructed; the missing
// reference is rejected when a buffer is opened.
func (t *Table) Add(f Field) error {
	if f.Name == "" {
		return fmt.Errorf("dataeng: field name must not be empty in table %q", t.name)
	}
	if t.byName[f.Name] != nil {
		return fmt.Errorf("dataeng: duplicate field name %q in table %q", f.Name, t.name)
	}
	if t.slotUsed[f.Slot] {
		return fmt.Errorf("dataeng: duplicate vtable slot %d in table %q", f.Slot, t.name)
	}
	if !knownKind(f.Kind) {
		return fmt.Errorf("dataeng: field %q in table %q uses unsupported kind %s", f.Name, t.name, f.Kind)
	}
	switch f.Kind {
	case KindU8:
		if f.Default < 0 || f.Default > math.MaxUint8 {
			return fmt.Errorf("dataeng: u8 field %q default %d out of range", f.Name, f.Default)
		}
		if f.RefTable != nil {
			return fmt.Errorf("dataeng: scalar field %q must not reference a table", f.Name)
		}
	case KindI32:
		if f.Default < math.MinInt32 || f.Default > math.MaxInt32 {
			return fmt.Errorf("dataeng: i32 field %q default %d out of range", f.Name, f.Default)
		}
		if f.RefTable != nil {
			return fmt.Errorf("dataeng: scalar field %q must not reference a table", f.Name)
		}
	case KindI64:
		if f.RefTable != nil {
			return fmt.Errorf("dataeng: scalar field %q must not reference a table", f.Name)
		}
	case KindString:
		if f.RefTable != nil {
			return fmt.Errorf("dataeng: string field %q must not reference a table", f.Name)
		}
	default:
		if f.RefTable != nil && f.RefTable.name == "" {
			return fmt.Errorf("dataeng: field %q references an unnamed table", f.Name)
		}
	}
	cp := f
	t.fields = append(t.fields, &cp)
	t.byName[cp.Name] = &cp
	t.slotUsed[cp.Slot] = true
	return nil
}

// Name returns the table name.
func (t *Table) Name() string { return t.name }

// Fields returns copies of the compiled field definitions.
func (t *Table) Fields() []Field {
	out := make([]Field, len(t.fields))
	for i, f := range t.fields {
		out[i] = *f
	}
	return out
}

func knownKind(k Kind) bool {
	switch k {
	case KindU8, KindI32, KindI64, KindString, KindTable,
		KindVectorU8, KindVectorI32, KindVectorI64, KindVectorTable:
		return true
	}
	return false
}

func isScalarKind(k Kind) bool {
	return k == KindU8 || k == KindI32 || k == KindI64
}

func isVectorKind(k Kind) bool {
	switch k {
	case KindVectorU8, KindVectorI32, KindVectorI64, KindVectorTable:
		return true
	}
	return false
}

func scalarSize(k Kind) int {
	switch k {
	case KindU8:
		return 1
	case KindI32:
		return 4
	case KindI64:
		return 8
	}
	return 0
}

func vectorElementKind(k Kind) Kind {
	switch k {
	case KindVectorU8:
		return KindU8
	case KindVectorI32:
		return KindI32
	case KindVectorI64:
		return KindI64
	case KindVectorTable:
		return KindTable
	}
	return 0
}
