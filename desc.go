package telemetry

import (
	"fmt"
	"math"
)

// Kind identifies how a Field is coded on the wire.
type Kind int

const (
	KindUInt    Kind = iota // unsigned integer of Width bits
	KindSInt                // two's complement integer of Width bits
	KindVarint              // unsigned base-128 varint
	KindSVarint             // zigzag varint
	KindBytes               // byte string of Width (or ref*LenMul) bytes
	KindAlign               // zero padding to a multiple of Width bits
	KindStruct              // nested field list
)

// Field describes one telemetry field. When LenRef names a previously
// decoded sibling field, the field's length is that field's value times
// LenMul (default 1): bits for KindUInt/KindSInt, bytes for KindBytes.
type Field struct {
	Name   string
	Kind   Kind
	Width  int
	LenRef string
	LenMul int
	Fields []Field
}

// Value is a decoded field. Start and End give the half-open bit range
// the field occupied in the stream, recorded in place for every field —
// including length-multiplied byte strings, sign-extended integers, and
// alignment padding.
type Value struct {
	Name  string
	Kind  Kind
	U     uint64
	S     int64
	B     []byte
	Start int
	End   int
	Kids  []*Value
}

// Decode reads a structure described by fields from r. On any failure —
// including inside a nested struct — r's cursor is rolled back to where
// Decode started and no partial Value is returned; bytes already cached
// from an external source are retained.
func Decode(r *Reader, fields []Field) (*Value, error) {
	return decodeStruct(r, fields, make(map[string]*Value))
}

func decodeStruct(r *Reader, fields []Field, vals map[string]*Value) (*Value, error) {
	start := r.Pos()
	out := &Value{Kind: KindStruct, Start: start}
	for _, f := range fields {
		v, err := decodeField(r, f, vals)
		if err != nil {
			r.Seek(start) // roll back cursor; cached external bytes stay
			return nil, err
		}
		out.Kids = append(out.Kids, v)
		if f.Name != "" {
			vals[f.Name] = v
		}
	}
	out.End = r.Pos()
	return out, nil
}

func (f Field) length(vals map[string]*Value) (int, error) {
	if f.LenRef == "" {
		return f.Width, nil
	}
	ref, ok := vals[f.LenRef]
	if !ok {
		return 0, fmt.Errorf("telemetry: unknown length ref %q", f.LenRef)
	}
	mul := f.LenMul
	if mul == 0 {
		mul = 1
	}
	if mul < 0 || ref.U > math.MaxInt32 {
		return 0, fmt.Errorf("%w: length %d x %d", ErrOverflow, ref.U, mul)
	}
	n := int(ref.U) * mul
	if n < 0 || n > math.MaxInt32 {
		return 0, fmt.Errorf("%w: length %d x %d", ErrOverflow, ref.U, mul)
	}
	return n, nil
}

func decodeField(r *Reader, f Field, vals map[string]*Value) (*Value, error) {
	start := r.Pos()
	v := &Value{Name: f.Name, Kind: f.Kind, Start: start}
	fail := func(err error) (*Value, error) {
		r.Seek(start)
		return nil, err
	}
	switch f.Kind {
	case KindUInt:
		w, err := f.length(vals)
		if err != nil {
			return fail(err)
		}
		u, err := r.ReadBits(w)
		if err != nil {
			return fail(err)
		}
		v.U, v.S = u, int64(u)
	case KindSInt:
		w, err := f.length(vals)
		if err != nil {
			return fail(err)
		}
		s, err := r.ReadSigned(w)
		if err != nil {
			return fail(err)
		}
		v.S, v.U = s, uint64(s)
	case KindVarint:
		u, err := r.ReadVarint()
		if err != nil {
			return fail(err)
		}
		v.U, v.S = u, int64(u)
	case KindSVarint:
		s, err := r.ReadVarintSigned()
		if err != nil {
			return fail(err)
		}
		v.S, v.U = s, uint64(s)
	case KindBytes:
		n, err := f.length(vals)
		if err != nil {
			return fail(err)
		}
		b := make([]byte, n)
		for i := range b {
			u, err := r.ReadBits(8)
			if err != nil {
				return fail(err)
			}
			b[i] = byte(u)
		}
		v.B = b
	case KindAlign:
		pad, err := r.Align(f.Width)
		if err != nil {
			return fail(err)
		}
		v.U = uint64(pad)
	case KindStruct:
		kid, err := decodeStruct(r, f.Fields, vals)
		if err != nil {
			return fail(err)
		}
		v.Kids = kid.Kids
	default:
		return fail(fmt.Errorf("telemetry: unknown field kind %d", f.Kind))
	}
	v.End = r.Pos()
	return v, nil
}
