// Package colcalc evaluates arithmetic, comparison and conditional
// expressions over JSON tables, row by row.
//
// Three states are kept independent from concrete values and from each
// other: Missing (key absent in the row), Null (JSON null) and Error
// (a computation failure such as a type mismatch or division by zero).
// None of them ever collapses into another or into a concrete value.
package colcalc

import (
	"encoding/json"
	"fmt"
)

// Kind classifies a Value.
type Kind int

const (
	Number Kind = iota
	String
	Bool
	Null    // JSON null
	Missing // key absent from the row
	Error   // computation failure
)

func (k Kind) String() string {
	switch k {
	case Number:
		return "number"
	case String:
		return "string"
	case Bool:
		return "bool"
	case Null:
		return "null"
	case Missing:
		return "missing"
	case Error:
		return "error"
	}
	return "unknown"
}

// Value is the result of evaluating an expression against one row.
type Value struct {
	Kind Kind
	Num  float64
	Str  string
	B    bool
	Err  error
}

func Numv(n float64) Value { return Value{Kind: Number, Num: n} }
func Strv(s string) Value  { return Value{Kind: String, Str: s} }
func Boolv(b bool) Value   { return Value{Kind: Bool, B: b} }
func Nullv() Value         { return Value{Kind: Null} }
func Missingv() Value      { return Value{Kind: Missing} }
func Errv(format string, args ...any) Value {
	return Value{Kind: Error, Err: fmt.Errorf(format, args...)}
}

// FromJSON converts a decoded JSON scalar into a Value. Nested objects
// and arrays are unsupported and become an Error value.
func FromJSON(v any) Value {
	switch t := v.(type) {
	case nil:
		return Nullv()
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return Errv("bad number %q", t.String())
		}
		return Numv(f)
	case float64:
		return Numv(t)
	case string:
		return Strv(t)
	case bool:
		return Boolv(t)
	default:
		return Errv("unsupported JSON value of type %T", v)
	}
}

// Equal reports whether two values are identical in kind and payload,
// keeping the three states distinguishable.
func Equal(a, b Value) bool {
	if a.Kind != b.Kind {
		return false
	}
	switch a.Kind {
	case Number:
		return a.Num == b.Num
	case String:
		return a.Str == b.Str
	case Bool:
		return a.B == b.B
	case Error:
		if a.Err == nil || b.Err == nil {
			return a.Err == b.Err
		}
		return a.Err.Error() == b.Err.Error()
	}
	return true // Null, Missing carry no payload
}

func (v Value) String() string {
	switch v.Kind {
	case Number:
		return fmt.Sprintf("number(%v)", v.Num)
	case String:
		return fmt.Sprintf("string(%q)", v.Str)
	case Bool:
		return fmt.Sprintf("bool(%v)", v.B)
	case Null:
		return "null"
	case Missing:
		return "missing"
	case Error:
		return fmt.Sprintf("error(%v)", v.Err)
	}
	return "unknown"
}

// MarshalJSON keeps the three states distinguishable on the wire:
// concrete scalars and null map to their natural JSON form, while
// missing and error use tagged objects.
func (v Value) MarshalJSON() ([]byte, error) {
	switch v.Kind {
	case Number:
		return json.Marshal(v.Num)
	case String:
		return json.Marshal(v.Str)
	case Bool:
		return json.Marshal(v.B)
	case Null:
		return []byte("null"), nil
	case Missing:
		return []byte(`{"$missing":true}`), nil
	case Error:
		msg := ""
		if v.Err != nil {
			msg = v.Err.Error()
		}
		return json.Marshal(map[string]string{"$error": msg})
	}
	return nil, fmt.Errorf("cannot marshal kind %v", v.Kind)
}
