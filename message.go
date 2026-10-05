package binmsg

import (
	"encoding/binary"
	"fmt"
)

// Schema declares the known fields of a message: field number -> expected
// wire type. Fields not in the schema (or with a mismatched wire type) are
// treated as unknown and preserved verbatim.
type Schema map[int]WireType

// Field is a single occurrence of a numbered field.
type Field struct {
	Number int
	Wire   WireType
	Known  bool
	// Value holds the decoded payload of a known field:
	// uint64 (WireVarint, WireFixed64), uint32 (WireFixed32) or
	// []byte (WireBytes).
	Value any
	// Raw holds the original encoded bytes (tag + payload) of an unknown
	// field. It is emitted unchanged on Marshal.
	Raw []byte
}

// Message is an ordered list of field occurrences.
type Message struct {
	Fields []*Field
}

// Parse decodes data according to schema. Unknown fields are kept as raw
// bytes in their original position.
func Parse(data []byte, schema Schema) (*Message, error) {
	m := &Message{}
	off := 0
	for off < len(data) {
		f, next, err := parseField(data, off, schema)
		if err != nil {
			return nil, err
		}
		m.Fields = append(m.Fields, f)
		off = next
	}
	return m, nil
}

func parseField(data []byte, off int, schema Schema) (*Field, int, error) {
	tagOff := off
	tag, off, err := readVarint(data, off)
	if err != nil {
		return nil, 0, err
	}
	num := int(tag >> 3)
	wt := WireType(tag & 7)
	if num == 0 {
		return nil, 0, &Error{Offset: tagOff, Msg: "invalid field number 0"}
	}
	if !wt.valid() {
		return nil, 0, &Error{Offset: tagOff, Msg: fmt.Sprintf("invalid wire type %d", int(wt))}
	}
	f := &Field{Number: num, Wire: wt}
	switch wt {
	case WireVarint:
		v, next, err := readVarint(data, off)
		if err != nil {
			return nil, 0, err
		}
		f.Value = v
		off = next
	case WireFixed64:
		if len(data)-off < 8 {
			return nil, 0, &Error{Offset: off, Msg: "truncated fixed64"}
		}
		f.Value = binary.LittleEndian.Uint64(data[off:])
		off += 8
	case WireBytes:
		n, next, err := readVarint(data, off)
		if err != nil {
			return nil, 0, err
		}
		off = next
		if n > uint64(len(data)-off) {
			return nil, 0, &Error{Offset: off, Msg: fmt.Sprintf("length %d exceeds remaining input", n)}
		}
		f.Value = data[off : off+int(n)]
		off += int(n)
	case WireFixed32:
		if len(data)-off < 4 {
			return nil, 0, &Error{Offset: off, Msg: "truncated fixed32"}
		}
		f.Value = binary.LittleEndian.Uint32(data[off:])
		off += 4
	}
	if wt, ok := schema[num]; ok && wt == f.Wire {
		f.Known = true
	} else {
		f.Raw = data[tagOff:off]
	}
	return f, off, nil
}

// Marshal encodes the message. Known fields are re-encoded from their
// current values; unknown fields are emitted from their preserved raw bytes,
// so their relative order is unchanged.
func (m *Message) Marshal() []byte {
	var out []byte
	for _, f := range m.Fields {
		out = f.appendTo(out)
	}
	return out
}

func (f *Field) appendTo(dst []byte) []byte {
	if !f.Known {
		return append(dst, f.Raw...)
	}
	dst = appendVarint(dst, uint64(f.Number)<<3|uint64(f.Wire))
	switch f.Wire {
	case WireVarint:
		return appendVarint(dst, f.Value.(uint64))
	case WireFixed64:
		var b [8]byte
		binary.LittleEndian.PutUint64(b[:], f.Value.(uint64))
		return append(dst, b[:]...)
	case WireBytes:
		dst = appendVarint(dst, uint64(len(f.Value.([]byte))))
		return append(dst, f.Value.([]byte)...)
	case WireFixed32:
		var b [4]byte
		binary.LittleEndian.PutUint32(b[:], f.Value.(uint32))
		return append(dst, b[:]...)
	}
	panic(fmt.Sprintf("binmsg: unsupported wire type %d", int(f.Wire)))
}

// Get returns the value of the first known occurrence of field num.
func (m *Message) Get(num int) (any, bool) {
	for _, f := range m.Fields {
		if f.Known && f.Number == num {
			return f.Value, true
		}
	}
	return nil, false
}

// Values returns the values of all known occurrences of field num, in order.
// It supports repeated fields.
func (m *Message) Values(num int) []any {
	var out []any
	for _, f := range m.Fields {
		if f.Known && f.Number == num {
			out = append(out, f.Value)
		}
	}
	return out
}

// Set replaces every known occurrence of field num with a single field
// holding v, positioned where the first occurrence was. If num does not
// occur, the field is appended at the end. Unknown fields are untouched.
// Integer values of any Go int/uint type are normalized to the field's
// storage type (uint64 or uint32).
func (m *Message) Set(num int, wt WireType, v any) {
	nf := &Field{Number: num, Wire: wt, Known: true, Value: normalizeValue(wt, v)}
	out := m.Fields[:0]
	placed := false
	for _, f := range m.Fields {
		if f.Known && f.Number == num {
			if !placed {
				out = append(out, nf)
				placed = true
			}
			continue
		}
		out = append(out, f)
	}
	if !placed {
		out = append(out, nf)
	}
	m.Fields = out
}

// Append adds a new occurrence of field num at the end of the message.
// Integer values of any Go int/uint type are normalized to the field's
// storage type (uint64 or uint32).
func (m *Message) Append(num int, wt WireType, v any) {
	m.Fields = append(m.Fields, &Field{Number: num, Wire: wt, Known: true, Value: normalizeValue(wt, v)})
}

// normalizeValue converts any Go integer type to the storage type of wt.
func normalizeValue(wt WireType, v any) any {
	switch wt {
	case WireVarint, WireFixed64:
		switch n := v.(type) {
		case int:
			return uint64(n)
		case int8:
			return uint64(n)
		case int16:
			return uint64(n)
		case int32:
			return uint64(n)
		case int64:
			return uint64(n)
		case uint:
			return uint64(n)
		case uint8:
			return uint64(n)
		case uint16:
			return uint64(n)
		case uint32:
			return uint64(n)
		}
	case WireFixed32:
		switch n := v.(type) {
		case int:
			return uint32(n)
		case int8:
			return uint32(n)
		case int16:
			return uint32(n)
		case int32:
			return uint32(n)
		case int64:
			return uint32(n)
		case uint:
			return uint32(n)
		case uint8:
			return uint32(n)
		case uint16:
			return uint32(n)
		case uint64:
			return uint32(n)
		}
	}
	return v
}

// Nested parses the payload of the first known WireBytes occurrence of field
// num as a nested message using schema.
func (m *Message) Nested(num int, schema Schema) (*Message, error) {
	v, ok := m.Get(num)
	if !ok {
		return nil, fmt.Errorf("binmsg: field %d not found", num)
	}
	b, ok := v.([]byte)
	if !ok {
		return nil, fmt.Errorf("binmsg: field %d is not length-delimited", num)
	}
	return Parse(b, schema)
}
