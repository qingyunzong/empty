package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"sort"
)

// Kind enumerates the field shapes supported by a schema.
type Kind int

const (
	// IntegerEnum is a nullable bounded integer enum.
	IntegerEnum Kind = iota + 1
	// EnumArray is an array of enum integers whose length is in [0, 3].
	EnumArray
)

// FieldSpec describes one object field.
//
// Enum gives the caller-defined enum order: its slice index is the rank
// used for typed value ordering, so two enums with the same values but
// different slice orders produce different enumeration sequences.
//
// Nullable is meaningful only for IntegerEnum. MinItems and MaxItems are
// meaningful only for EnumArray, and MaxItems must not exceed 3.
type FieldSpec struct {
	Name     string
	Kind     Kind
	Required bool
	Nullable bool
	Enum     []int
	MinItems int
	MaxItems int
}

// Schema is a finite record schema with at most eight named fields.
type Schema struct {
	Fields []FieldSpec
}

const maxFields = 8
const maxArrayItems = 3

// validate normalizes a schema into a name-sorted, internally consistent
// representation, rejecting every shape the finite domain cannot cover.
func validate(s *Schema) ([]FieldSpec, error) {
	if s == nil {
		return nil, errors.New("dataeng: nil schema")
	}
	if len(s.Fields) > maxFields {
		return nil, fmt.Errorf("dataeng: schema has %d fields, limit is %d", len(s.Fields), maxFields)
	}
	out := make([]FieldSpec, len(s.Fields))
	names := make(map[string]struct{}, len(s.Fields))
	for i, f := range s.Fields {
		if f.Name == "" {
			return nil, fmt.Errorf("dataeng: field %d has an empty name", i)
		}
		if _, dup := names[f.Name]; dup {
			return nil, fmt.Errorf("dataeng: duplicate field name %q", f.Name)
		}
		names[f.Name] = struct{}{}
		if len(f.Enum) == 0 {
			return nil, fmt.Errorf("dataeng: field %q has an empty enum", f.Name)
		}
		seen := make(map[int]struct{}, len(f.Enum))
		for _, v := range f.Enum {
			if _, dup := seen[v]; dup {
				return nil, fmt.Errorf("dataeng: field %q has duplicate enum value %d", f.Name, v)
			}
			seen[v] = struct{}{}
		}
		switch f.Kind {
		case IntegerEnum:
			if f.MinItems != 0 || f.MaxItems != 0 {
				return nil, fmt.Errorf("dataeng: integer enum field %q must not set array bounds", f.Name)
			}
		case EnumArray:
			if f.Nullable {
				return nil, fmt.Errorf("dataeng: array field %q cannot be nullable", f.Name)
			}
			if f.MinItems < 0 {
				return nil, fmt.Errorf("dataeng: field %q has negative MinItems", f.Name)
			}
			if f.MaxItems > maxArrayItems {
				return nil, fmt.Errorf("dataeng: field %q MaxItems %d exceeds limit %d", f.Name, f.MaxItems, maxArrayItems)
			}
			if f.MinItems > f.MaxItems {
				return nil, fmt.Errorf("dataeng: field %q MinItems %d > MaxItems %d", f.Name, f.MinItems, f.MaxItems)
			}
		default:
			return nil, fmt.Errorf("dataeng: field %q has unknown kind %d", f.Name, f.Kind)
		}
		out[i] = f
		out[i].Enum = append([]int(nil), f.Enum...)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// valueKind discriminates the three legal typed values so the zero Value
// stays distinguishable from a real integer 0 or an empty array.
type valueKind int

const (
	valueInvalid valueKind = iota
	valueNull
	valueInt
	valueArray
)

// Value is a typed field value. The zero value is not valid; construct
// instances with NullValue, IntValue or ArrayValue.
type Value struct {
	kind valueKind
	int  int
	arr  []int
}

// NullValue returns the null value.
func NullValue() Value { return Value{kind: valueNull} }

// IntValue returns an integer enum value.
func IntValue(v int) Value { return Value{kind: valueInt, int: v} }

// ArrayValue returns an enum array value.
func ArrayValue(elems ...int) Value {
	return Value{kind: valueArray, arr: append([]int(nil), elems...)}
}

// IsNull reports whether the value is null.
func (v Value) IsNull() bool { return v.kind == valueNull }

// AsInt returns the integer and true for integer values.
func (v Value) AsInt() (int, bool) {
	if v.kind != valueInt {
		return 0, false
	}
	return v.int, true
}

// AsArray returns the array elements and true for array values.
func (v Value) AsArray() ([]int, bool) {
	if v.kind != valueArray {
		return nil, false
	}
	return append([]int(nil), v.arr...), true
}

// MarshalJSON renders null, a JSON number or a JSON array.
func (v Value) MarshalJSON() ([]byte, error) {
	switch v.kind {
	case valueNull:
		return []byte("null"), nil
	case valueArray:
		var b bytes.Buffer
		b.WriteByte('[')
		for i, e := range v.arr {
			if i > 0 {
				b.WriteByte(',')
			}
			fmt.Fprintf(&b, "%d", e)
		}
		b.WriteByte(']')
		return b.Bytes(), nil
	case valueInt:
		return []byte(fmt.Sprintf("%d", v.int)), nil
	default:
		return nil, errors.New("dataeng: invalid Value")
	}
}

// Record is an object value. Only present keys are stored: a missing field
// has no map entry and is never rendered as a value or sentinel.
type Record map[string]Value

// MarshalJSON renders the record with keys sorted lexicographically.
func (r Record) MarshalJSON() ([]byte, error) {
	keys := make([]string, 0, len(r))
	for k := range r {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := jsonMarshalString(k)
		if err != nil {
			return nil, err
		}
		b.Write(key)
		b.WriteByte(':')
		raw, err := r[k].MarshalJSON()
		if err != nil {
			return nil, err
		}
		b.Write(raw)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// String renders the canonical JSON form of the record.
func (r Record) String() string {
	raw, err := r.MarshalJSON()
	if err != nil {
		return fmt.Sprintf("Record<%v>", err)
	}
	return string(raw)
}
