package dataeng

import (
	"fmt"
	"sort"
)

// Type is the compact payload type code carried in a field header or in a
// container header nibble.
type Type uint8

const (
	// TypeEnd terminates a structure. It is never a value type.
	TypeEnd Type = 0

	// TypeTrue and TypeFalse are the two boolean values. They carry no
	// additional value bytes.
	TypeTrue  Type = 1
	TypeFalse Type = 2

	// TypeByte is an opaque eight-bit scalar. The byte is stored verbatim.
	TypeByte Type = 3

	// TypeInt16, TypeInt32 and TypeInt64 are signed integers encoded as
	// unsigned LEB128 of a zig-zag value at the stated width.
	TypeInt16 Type = 4
	TypeInt32 Type = 5
	TypeInt64 Type = 6

	// TypeFloat64 is an IEEE-754 binary64 stored little-endian.
	TypeFloat64 Type = 7

	// TypeBytes is a length-delimited run of raw bytes.
	TypeBytes Type = 8

	// TypeList and TypeSet are containers with a single element type.
	TypeList Type = 9
	TypeSet  Type = 10

	// TypeMap is a container of key/value pairs.
	TypeMap Type = 11

	// TypeStruct is a nested structure with delta-coded field identifiers.
	TypeStruct Type = 12
)

// Conventional aliases used by callers that prefer descriptive names.
const (
	TypeBoolTrue  = TypeTrue
	TypeBoolFalse = TypeFalse
	TypeInt8      = TypeByte
	TypeFloat     = TypeFloat64
	TypeBinary    = TypeBytes
)

// FieldSchema describes one field of a structure. Schema supplies the full
// shape of the field value. Type is a convenience alternative for scalar
// fields; when both are set they must agree.
type FieldSchema struct {
	ID     uint32
	Type   Type
	Schema *Schema
}

// Schema is a caller-supplied description of the one value to be decoded.
//
// For a structure, Fields lists the permitted fields. Their identifiers must
// be positive and unique; they may be supplied in any order. For a list or set,
// Elem describes the element type and must be a container-legal type (not 0, 1
// or 2). For a map, Key and Value describe the key and value types.
type Schema struct {
	Type   Type
	Fields []FieldSchema
	Elem   *Schema
	Key    *Schema
	Value  *Schema
}

// Scalar returns a schema for a scalar type.
func Scalar(t Type) *Schema {
	return &Schema{Type: t}
}

// Struct returns a structure schema. Fields are sorted by identifier for
// convenience; the decoder does not require callers to pre-sort them.
func Struct(fields ...FieldSchema) *Schema {
	sorted := append([]FieldSchema(nil), fields...)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].ID < sorted[j].ID
	})
	return &Schema{Type: TypeStruct, Fields: sorted}
}

// List returns a list schema with the given element schema.
func List(elem *Schema) *Schema {
	return &Schema{Type: TypeList, Elem: elem}
}

// Set returns a set schema with the given element schema.
func Set(elem *Schema) *Schema {
	return &Schema{Type: TypeSet, Elem: elem}
}

// Map returns a map schema with the given key and value schemas.
func Map(key, value *Schema) *Schema {
	return &Schema{Type: TypeMap, Key: key, Value: value}
}

// Field returns a structure-field schema that refers to a complete child
// schema.
func Field(id uint32, schema *Schema) FieldSchema {
	return FieldSchema{ID: id, Schema: schema}
}

// FieldOf returns a structure-field schema for a scalar type.
func FieldOf(id uint32, t Type) FieldSchema {
	return FieldSchema{ID: id, Type: t}
}

// Value is the decoded value. Type selects which of the remaining fields is
// meaningful.
type Value struct {
	Type Type

	Bool bool
	Byte byte
	Int  int64

	Float     float64
	FloatBits uint64

	Bytes []byte

	Elements []Value
	Entries  []MapEntry
	Fields   []FieldValue
}

// FieldValue is one field of a decoded structure, in wire order.
type FieldValue struct {
	ID    uint32
	Value Value
}

// MapEntry is one key/value pair of a decoded map, in wire order.
type MapEntry struct {
	Key   Value
	Value Value
}

// LookupField returns the field with the given identifier.
func (v Value) LookupField(id uint32) (Value, bool) {
	for _, f := range v.Fields {
		if f.ID == id {
			return f.Value, true
		}
	}
	return Value{}, false
}

// LookupEntry returns the first map entry whose key is a scalar equal to key.
// It is intended as a convenience for the common scalar-key case.
func (v Value) LookupEntry(key Value) (Value, bool) {
	for _, e := range v.Entries {
		if scalarEqual(e.Key, key) {
			return e.Value, true
		}
	}
	return Value{}, false
}

func scalarEqual(a, b Value) bool {
	if a.Type != b.Type {
		return false
	}
	switch a.Type {
	case TypeTrue, TypeFalse:
		return a.Bool == b.Bool
	case TypeByte:
		return a.Byte == b.Byte
	case TypeInt16, TypeInt32, TypeInt64:
		return a.Int == b.Int
	case TypeFloat64:
		return a.FloatBits == b.FloatBits
	case TypeBytes:
		if len(a.Bytes) != len(b.Bytes) {
			return false
		}
		for i := range a.Bytes {
			if a.Bytes[i] != b.Bytes[i] {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// Interface returns a natural Go representation of the value. Structure
// values become map[uint32]any, list and set values become []any, and map
// values become []MapEntry so that composite keys remain representable.
func (v Value) Interface() any {
	switch v.Type {
	case TypeTrue, TypeFalse:
		return v.Bool
	case TypeByte:
		return v.Byte
	case TypeInt16:
		return int16(v.Int)
	case TypeInt32:
		return int32(v.Int)
	case TypeInt64:
		return v.Int
	case TypeFloat64:
		return v.Float
	case TypeBytes:
		return append([]byte(nil), v.Bytes...)
	case TypeList, TypeSet:
		out := make([]any, len(v.Elements))
		for i := range v.Elements {
			out[i] = v.Elements[i].Interface()
		}
		return out
	case TypeMap:
		out := make([]MapEntry, len(v.Entries))
		copy(out, v.Entries)
		return out
	case TypeStruct:
		out := make(map[uint32]any, len(v.Fields))
		for _, f := range v.Fields {
			out[f.ID] = f.Value.Interface()
		}
		return out
	default:
		return nil
	}
}

func (t Type) validValue() bool {
	return t >= TypeTrue && t <= TypeStruct
}

func (t Type) validContainerComponent() bool {
	return t >= TypeByte && t <= TypeStruct
}

func resolveField(f FieldSchema) (*Schema, error) {
	if f.Schema != nil {
		if f.Type != 0 && f.Type != f.Schema.Type {
			return nil, fmt.Errorf("%w: field %d declares type %d but schema is type %d", ErrSchema, f.ID, f.Type, f.Schema.Type)
		}
		return f.Schema, nil
	}
	if !f.Type.validValue() {
		return nil, fmt.Errorf("%w: field %d has invalid type %d", ErrSchema, f.ID, f.Type)
	}
	if f.Type >= TypeList {
		return nil, fmt.Errorf("%w: field %d has container type %d without a schema", ErrSchema, f.ID, f.Type)
	}
	return &Schema{Type: f.Type}, nil
}

func validateSchema(root *Schema) error {
	seen := make(map[*Schema]bool)
	var walk func(*Schema) error
	walk = func(node *Schema) error {
		if node == nil {
			return fmt.Errorf("%w: nil schema", ErrSchema)
		}
		if seen[node] {
			return nil
		}
		seen[node] = true

		if !node.Type.validValue() {
			return fmt.Errorf("%w: invalid value type %d", ErrSchema, node.Type)
		}

		switch node.Type {
		case TypeStruct:
			ids := make(map[uint32]bool, len(node.Fields))
			for _, f := range node.Fields {
				if f.ID == 0 {
					return fmt.Errorf("%w: structure field identifier must be positive", ErrSchema)
				}
				if ids[f.ID] {
					return fmt.Errorf("%w: duplicate structure field identifier %d", ErrSchema, f.ID)
				}
				ids[f.ID] = true
				child, err := resolveField(f)
				if err != nil {
					return err
				}
				if err := walk(child); err != nil {
					return err
				}
			}
		case TypeList, TypeSet:
			if node.Elem == nil {
				return fmt.Errorf("%w: container has no element schema", ErrSchema)
			}
			if !node.Elem.Type.validContainerComponent() {
				return fmt.Errorf("%w: container element type %d is not permitted", ErrSchema, node.Elem.Type)
			}
			if err := walk(node.Elem); err != nil {
				return err
			}
		case TypeMap:
			if node.Key == nil || node.Value == nil {
				return fmt.Errorf("%w: map schema needs both key and value schemas", ErrSchema)
			}
			if !node.Key.Type.validContainerComponent() {
				return fmt.Errorf("%w: map key type %d is not permitted", ErrSchema, node.Key.Type)
			}
			if !node.Value.Type.validContainerComponent() {
				return fmt.Errorf("%w: map value type %d is not permitted", ErrSchema, node.Value.Type)
			}
			if err := walk(node.Key); err != nil {
				return err
			}
			if err := walk(node.Value); err != nil {
				return err
			}
		}
		return nil
	}
	return walk(root)
}
