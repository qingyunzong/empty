package dataeng

import (
	"bytes"
	"cmp"
)

// Kind identifies the type of a key component Value.
type Kind uint8

const (
	KindNull Kind = iota
	KindInt
	KindFloat
	KindString
	KindBytes
	KindBool
)

// Value is a single component of a composite sort key.
// NULL sorts below every non-NULL value.
type Value struct {
	Kind Kind
	I64  int64
	F64  float64
	S    string
	B    []byte
	Bl   bool
}

func Null() Value       { return Value{Kind: KindNull} }
func Int(v int64) Value { return Value{Kind: KindInt, I64: v} }
func Float(v float64) Value {
	return Value{Kind: KindFloat, F64: v}
}
func Str(v string) Value { return Value{Kind: KindString, S: v} }
func Bytes(v []byte) Value {
	return Value{Kind: KindBytes, B: v}
}
func Bool(v bool) Value { return Value{Kind: KindBool, Bl: v} }

// Compare orders values by kind rank first (NULL lowest), then by value.
func (v Value) Compare(o Value) int {
	if v.Kind != o.Kind {
		return cmp.Compare(v.Kind, o.Kind)
	}
	switch v.Kind {
	case KindNull:
		return 0
	case KindInt:
		return cmp.Compare(v.I64, o.I64)
	case KindFloat:
		return cmp.Compare(v.F64, o.F64)
	case KindString:
		return cmp.Compare(v.S, o.S)
	case KindBytes:
		return bytes.Compare(v.B, o.B)
	case KindBool:
		switch {
		case v.Bl == o.Bl:
			return 0
		case !v.Bl:
			return -1
		default:
			return 1
		}
	}
	return 0
}

// Equal reports value equality where NULL equals NULL (null-safe).
func (v Value) Equal(o Value) bool { return v.Compare(o) == 0 }

// Key is a composite sort key.
type Key []Value

// CompareKeys lexicographically compares two composite keys.
func CompareKeys(a, b Key) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if c := a[i].Compare(b[i]); c != 0 {
			return c
		}
	}
	return cmp.Compare(len(a), len(b))
}

// HasNull reports whether any component of the key is NULL.
func (k Key) HasNull() bool {
	for _, v := range k {
		if v.Kind == KindNull {
			return true
		}
	}
	return false
}

// NullSafeEqual reports component-wise equality where NULL equals NULL.
func NullSafeEqual(a, b Key) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !a[i].Equal(b[i]) {
			return false
		}
	}
	return true
}
