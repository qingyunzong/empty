package dataeng

// Kind identifies the Avro type of a schema node.
type Kind int

const (
	KindNull Kind = iota
	KindBoolean
	KindInt
	KindLong
	KindFloat
	KindDouble
	KindBytes
	KindString
	KindRecord
	KindEnum
	KindArray
	KindMap
	KindUnion
	KindFixed
)

func (k Kind) String() string {
	switch k {
	case KindNull:
		return "null"
	case KindBoolean:
		return "boolean"
	case KindInt:
		return "int"
	case KindLong:
		return "long"
	case KindFloat:
		return "float"
	case KindDouble:
		return "double"
	case KindBytes:
		return "bytes"
	case KindString:
		return "string"
	case KindRecord:
		return "record"
	case KindEnum:
		return "enum"
	case KindArray:
		return "array"
	case KindMap:
		return "map"
	case KindUnion:
		return "union"
	case KindFixed:
		return "fixed"
	}
	return "unknown"
}

// Type is a parsed Avro schema node.
type Type interface {
	Kind() Kind
}

// Named is a named Avro type (record, enum, fixed).
type Named interface {
	Type
	Fullname() string
	TypeAliases() []string
}

// Primitive is one of the Avro primitive types.
type Primitive struct {
	kind Kind
}

func (p *Primitive) Kind() Kind { return p.kind }

var primitives = map[string]*Primitive{
	"null":    {KindNull},
	"boolean": {KindBoolean},
	"int":     {KindInt},
	"long":    {KindLong},
	"float":   {KindFloat},
	"double":  {KindDouble},
	"bytes":   {KindBytes},
	"string":  {KindString},
}

func isPrimitiveName(s string) bool {
	_, ok := primitives[s]
	return ok
}

func primitiveByName(s string) *Primitive { return primitives[s] }

// Record is an Avro record type. Fields may reference the record itself
// (recursive records), so a *Record can appear inside its own tree.
type Record struct {
	Name    string // fullname, namespace included
	Aliases []string
	Fields  []*Field
}

func (r *Record) Kind() Kind            { return KindRecord }
func (r *Record) Fullname() string      { return r.Name }
func (r *Record) TypeAliases() []string { return r.Aliases }

// Field is a record field.
type Field struct {
	Name       string
	Aliases    []string
	Type       Type
	Default    any
	HasDefault bool
	Order      string
}

// Enum is an Avro enum type.
type Enum struct {
	Name       string
	Aliases    []string
	Symbols    []string
	Default    string
	HasDefault bool
}

func (e *Enum) Kind() Kind            { return KindEnum }
func (e *Enum) Fullname() string      { return e.Name }
func (e *Enum) TypeAliases() []string { return e.Aliases }

// Fixed is an Avro fixed type.
type Fixed struct {
	Name    string
	Aliases []string
	Size    int
}

func (f *Fixed) Kind() Kind            { return KindFixed }
func (f *Fixed) Fullname() string      { return f.Name }
func (f *Fixed) TypeAliases() []string { return f.Aliases }

// Array is an Avro array type.
type Array struct {
	Items Type
}

func (a *Array) Kind() Kind { return KindArray }

// Map is an Avro map type.
type Map struct {
	Values Type
}

func (m *Map) Kind() Kind { return KindMap }

// Union is an Avro union type.
type Union struct {
	Types []Type
}

func (u *Union) Kind() Kind { return KindUnion }

// typeLabel returns a short human-readable label for a type.
func typeLabel(t Type) string {
	switch t := t.(type) {
	case *Primitive:
		return t.Kind().String()
	case Named:
		return t.Fullname()
	case *Array:
		return "array"
	case *Map:
		return "map"
	case *Union:
		return "union"
	}
	return "unknown"
}
