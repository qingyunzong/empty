// Package wiremsg implements a protobuf-style binary wire format with
// numbered fields, repeated values and nested messages. Unknown fields are
// preserved byte-exactly and keep their relative order across edits.
package wiremsg

import (
	"encoding/binary"
	"fmt"
)

// WireType is the low 3-bit type tag of a field.
type WireType int

const (
	Varint  WireType = 0
	Fixed64 WireType = 1
	Bytes   WireType = 2 // length-delimited
	Fixed32 WireType = 5
)

func (t WireType) valid() bool {
	switch t {
	case Varint, Fixed64, Bytes, Fixed32:
		return true
	}
	return false
}

// ParseError describes a decode failure. Offset is the byte position in the
// input where the problem was detected (for an illegal wire type, the start
// of the offending tag).
type ParseError struct {
	Offset int
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("wiremsg: parse error at offset %d: %s", e.Offset, e.Reason)
}

// Field is a single occurrence of a numbered field. Raw holds the value
// bytes exactly as they appear on the wire: for Varint the (possibly
// non-canonical) varint bytes, for Fixed32/Fixed64 the little-endian bytes,
// for Bytes the length-delimited content (without the length prefix).
// Keeping Raw verbatim lets unknown fields round-trip byte-identically.
type Field struct {
	Number int
	Type   WireType
	Raw    []byte
}

// Value decodes the field as a varint.
func (f Field) Value() (uint64, error) {
	if f.Type != Varint {
		return 0, fmt.Errorf("wiremsg: field %d is wire type %d, not varint", f.Number, f.Type)
	}
	v, n := binary.Uvarint(f.Raw)
	if n <= 0 || n != len(f.Raw) {
		return 0, fmt.Errorf("wiremsg: field %d has malformed varint", f.Number)
	}
	return v, nil
}

// Message is an ordered sequence of fields. Repeated fields appear as
// consecutive (or interleaved) entries with the same Number.
type Message struct {
	fields []Field
}

// Parse decodes data into a Message, preserving every field in wire order.
func Parse(data []byte) (*Message, error) {
	m := &Message{}
	pos := 0
	for pos < len(data) {
		tagStart := pos
		tag, n := binary.Uvarint(data[pos:])
		if n <= 0 {
			return nil, &ParseError{Offset: tagStart, Reason: "truncated or malformed tag"}
		}
		pos += n
		num := int(tag >> 3)
		wt := WireType(tag & 7)
		if num == 0 {
			return nil, &ParseError{Offset: tagStart, Reason: "field number 0 is not allowed"}
		}
		if !wt.valid() {
			return nil, &ParseError{Offset: tagStart, Reason: fmt.Sprintf("illegal wire type %d", wt)}
		}
		var raw []byte
		switch wt {
		case Varint:
			_, vn := binary.Uvarint(data[pos:])
			if vn <= 0 {
				return nil, &ParseError{Offset: pos, Reason: "truncated or malformed varint value"}
			}
			raw = data[pos : pos+vn]
			pos += vn
		case Fixed64:
			if len(data)-pos < 8 {
				return nil, &ParseError{Offset: pos, Reason: "truncated fixed64 value"}
			}
			raw = data[pos : pos+8]
			pos += 8
		case Bytes:
			l, ln := binary.Uvarint(data[pos:])
			if ln <= 0 {
				return nil, &ParseError{Offset: pos, Reason: "truncated or malformed length prefix"}
			}
			pos += ln
			if uint64(len(data)-pos) < l {
				return nil, &ParseError{Offset: pos, Reason: "truncated length-delimited value"}
			}
			raw = data[pos : pos+int(l)]
			pos += int(l)
		case Fixed32:
			if len(data)-pos < 4 {
				return nil, &ParseError{Offset: pos, Reason: "truncated fixed32 value"}
			}
			raw = data[pos : pos+4]
			pos += 4
		}
		m.fields = append(m.fields, Field{Number: num, Type: wt, Raw: raw})
	}
	return m, nil
}

// Marshal encodes the message back to wire format. Untouched fields,
// including unknown ones, are emitted byte-identically in their original
// relative order.
func (m *Message) Marshal() []byte {
	var out []byte
	var tag [binary.MaxVarintLen64]byte
	for _, f := range m.fields {
		n := binary.PutUvarint(tag[:], uint64(f.Number)<<3|uint64(f.Type))
		out = append(out, tag[:n]...)
		if f.Type == Bytes {
			n := binary.PutUvarint(tag[:], uint64(len(f.Raw)))
			out = append(out, tag[:n]...)
		}
		out = append(out, f.Raw...)
	}
	return out
}

// Fields returns all occurrences of field number num, in wire order.
func (m *Message) Fields(num int) []Field {
	var out []Field
	for _, f := range m.fields {
		if f.Number == num {
			out = append(out, f)
		}
	}
	return out
}

// All returns every field in wire order.
func (m *Message) All() []Field {
	out := make([]Field, len(m.fields))
	copy(out, m.fields)
	return out
}

// GetVarints decodes all varint occurrences of num (repeated values).
func (m *Message) GetVarints(num int) ([]uint64, error) {
	var out []uint64
	for _, f := range m.Fields(num) {
		v, err := f.Value()
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// GetVarint decodes the first varint occurrence of num.
func (m *Message) GetVarint(num int) (uint64, bool, error) {
	vs, err := m.GetVarints(num)
	if err != nil || len(vs) == 0 {
		return 0, false, err
	}
	return vs[0], true, nil
}

// GetBytes returns the contents of all length-delimited occurrences of num.
func (m *Message) GetBytes(num int) [][]byte {
	var out [][]byte
	for _, f := range m.Fields(num) {
		if f.Type == Bytes {
			b := make([]byte, len(f.Raw))
			copy(b, f.Raw)
			out = append(out, b)
		}
	}
	return out
}

// GetMessage parses the first length-delimited occurrence of num as a
// nested message.
func (m *Message) GetMessage(num int) (*Message, bool, error) {
	for _, f := range m.fields {
		if f.Number == num && f.Type == Bytes {
			sub, err := Parse(f.Raw)
			if err != nil {
				return nil, false, err
			}
			return sub, true, nil
		}
	}
	return nil, false, nil
}

// replace swaps every occurrence of num for repl, inserting at the position
// of the first existing occurrence (or appending if none). Fields with other
// numbers — known or unknown — keep their exact relative order.
func (m *Message) replace(num int, repl []Field) {
	var next []Field
	inserted := false
	for _, f := range m.fields {
		if f.Number != num {
			next = append(next, f)
			continue
		}
		if !inserted {
			next = append(next, repl...)
			inserted = true
		}
	}
	if !inserted {
		next = append(next, repl...)
	}
	m.fields = next
}

func varintRaw(v uint64) []byte {
	var buf [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(buf[:], v)
	out := make([]byte, n)
	copy(out, buf[:n])
	return out
}

// SetVarints replaces all occurrences of num with the given repeated varint
// values. Unknown fields keep their relative order.
func (m *Message) SetVarints(num int, vals ...uint64) {
	repl := make([]Field, len(vals))
	for i, v := range vals {
		repl[i] = Field{Number: num, Type: Varint, Raw: varintRaw(v)}
	}
	m.replace(num, repl)
}

// SetVarint sets a single varint value for num.
func (m *Message) SetVarint(num int, v uint64) { m.SetVarints(num, v) }

// SetBytes replaces all occurrences of num with the given repeated
// length-delimited values.
func (m *Message) SetBytes(num int, vals ...[]byte) {
	repl := make([]Field, len(vals))
	for i, v := range vals {
		raw := make([]byte, len(v))
		copy(raw, v)
		repl[i] = Field{Number: num, Type: Bytes, Raw: raw}
	}
	m.replace(num, repl)
}

// SetMessage replaces all occurrences of num with nested messages.
func (m *Message) SetMessage(num int, subs ...*Message) {
	vals := make([][]byte, len(subs))
	for i, s := range subs {
		vals[i] = s.Marshal()
	}
	m.SetBytes(num, vals...)
}

// Append adds a field occurrence at the end of the message.
func (m *Message) Append(num int, wt WireType, raw []byte) error {
	if num <= 0 {
		return fmt.Errorf("wiremsg: field number must be positive, got %d", num)
	}
	if !wt.valid() {
		return fmt.Errorf("wiremsg: illegal wire type %d", wt)
	}
	b := make([]byte, len(raw))
	copy(b, raw)
	m.fields = append(m.fields, Field{Number: num, Type: wt, Raw: b})
	return nil
}

// AppendVarint appends a varint field occurrence.
func (m *Message) AppendVarint(num int, v uint64) error {
	return m.Append(num, Varint, varintRaw(v))
}

// AppendBytes appends a length-delimited field occurrence.
func (m *Message) AppendBytes(num int, b []byte) error {
	return m.Append(num, Bytes, b)
}

// New returns an empty message.
func New() *Message { return &Message{} }
