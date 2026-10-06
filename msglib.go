// Package msglib implements a tag-length-payload (TLV) message codec.
//
// Wire format of a packet body: a sequence of fields, each encoded as
//
//	tag     unsigned varint
//	length  unsigned varint, byte count of payload
//	payload length bytes
//
// Parsing rules:
//   - repeated scalar tag: the last occurrence wins;
//   - repeated list tag: occurrences are concatenated in encounter order;
//   - unknown tag: the raw field bytes are preserved in encounter order;
//   - a declared length exceeding the remaining bytes rejects the whole packet.
//
// Canonical re-encoding emits known tags in ascending order (a list tag emits
// one field per element, in order), followed by unknown fields in their
// original relative order.
package msglib

import (
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
)

// ErrTruncated reports a field whose declared length exceeds the remaining
// packet bytes, or a truncated varint. The whole packet is rejected.
var ErrTruncated = errors.New("msglib: declared length exceeds remaining packet bytes")

// Kind describes how repeated occurrences of a known tag are merged.
type Kind int

const (
	// Scalar keeps only the last occurrence of a repeated tag.
	Scalar Kind = iota
	// List concatenates all occurrences of a repeated tag.
	List
)

// FieldSpec declares one known tag.
type FieldSpec struct {
	Tag  uint64
	Kind Kind
}

// Schema maps known tag numbers to their merge kind.
type Schema map[uint64]Kind

// NewSchema builds a Schema from field specifications.
func NewSchema(specs ...FieldSpec) Schema {
	s := make(Schema, len(specs))
	for _, sp := range specs {
		s[sp.Tag] = sp.Kind
	}
	return s
}

// Message is a parsed packet.
type Message struct {
	schema  Schema
	scalars map[uint64][]byte
	lists   map[uint64][][]byte
	unknown [][]byte // raw encoded bytes of unknown fields, in encounter order
}

func newMessage(schema Schema) *Message {
	return &Message{
		schema:  schema,
		scalars: make(map[uint64][]byte),
		lists:   make(map[uint64][][]byte),
	}
}

// Parse decodes one packet body. Any malformed field — in particular a
// declared length beyond the remaining bytes — rejects the whole packet.
func Parse(data []byte, schema Schema) (*Message, error) {
	m := newMessage(schema)
	rest := data
	for len(rest) > 0 {
		field := rest
		tag, n := binary.Uvarint(rest)
		if n <= 0 {
			return nil, fmt.Errorf("msglib: bad tag varint: %w", ErrTruncated)
		}
		rest = rest[n:]
		length, n := binary.Uvarint(rest)
		if n <= 0 {
			return nil, fmt.Errorf("msglib: bad length varint: %w", ErrTruncated)
		}
		rest = rest[n:]
		if length > uint64(len(rest)) {
			return nil, fmt.Errorf("msglib: tag %d declares %d bytes with %d remaining: %w",
				tag, length, len(rest), ErrTruncated)
		}
		payload := rest[:length]
		rest = rest[length:]
		raw := field[:len(field)-len(rest)]

		switch kind, known := schema[tag]; {
		case !known:
			m.unknown = append(m.unknown, append([]byte(nil), raw...))
		case kind == Scalar:
			m.scalars[tag] = append([]byte(nil), payload...)
		case kind == List:
			m.lists[tag] = append(m.lists[tag], append([]byte(nil), payload...))
		}
	}
	return m, nil
}

// Scalar returns the last value seen for a scalar tag.
func (m *Message) Scalar(tag uint64) ([]byte, bool) {
	v, ok := m.scalars[tag]
	return v, ok
}

// List returns the concatenated values of a list tag, in encounter order.
func (m *Message) List(tag uint64) [][]byte {
	return m.lists[tag]
}

// UnknownFields returns the raw encoded bytes of each unknown field, in
// their original relative order.
func (m *Message) UnknownFields() [][]byte {
	return m.unknown
}

// SetScalar sets a scalar tag value.
func (m *Message) SetScalar(tag uint64, payload []byte) {
	m.scalars[tag] = append([]byte(nil), payload...)
}

// Append adds one element to a list tag.
func (m *Message) Append(tag uint64, payload []byte) {
	m.lists[tag] = append(m.lists[tag], append([]byte(nil), payload...))
}

// Encode serializes the message in canonical form: known tags ascending,
// list elements as repeated fields in order, then unknown fields in their
// original relative order.
func (m *Message) Encode() []byte {
	tags := make([]uint64, 0, len(m.scalars)+len(m.lists))
	for tag := range m.scalars {
		tags = append(tags, tag)
	}
	for tag := range m.lists {
		if _, ok := m.scalars[tag]; !ok {
			tags = append(tags, tag)
		}
	}
	sort.Slice(tags, func(i, j int) bool { return tags[i] < tags[j] })

	var out []byte
	for _, tag := range tags {
		if payload, ok := m.scalars[tag]; ok {
			out = AppendField(out, tag, payload)
			continue
		}
		for _, item := range m.lists[tag] {
			out = AppendField(out, tag, item)
		}
	}
	for _, raw := range m.unknown {
		out = append(out, raw...)
	}
	return out
}

// AppendField appends one tag-length-payload field to dst.
func AppendField(dst []byte, tag uint64, payload []byte) []byte {
	var buf [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(buf[:], tag)
	dst = append(dst, buf[:n]...)
	n = binary.PutUvarint(buf[:], uint64(len(payload)))
	dst = append(dst, buf[:n]...)
	return append(dst, payload...)
}
