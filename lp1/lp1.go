// Package lp1 implements the closed LP1 compact list-page encoding used by the
// archive ingestion host.
//
// LP1 is deliberately not aligned with any Redis listpack version; its reverse
// length encoding in particular differs from listpack: an LP1 reverse length
// writes L (the body length only) in minimal 7-bit groups with the first high
// bit clear and every continuation high bit set, whereas listpack prepends a
// different backlen scheme. No compatibility with any Redis version is
// promised. See README.md for the full format description.
package lp1

import (
	"encoding/binary"
	"errors"
)

// Sentinel errors returned by the package.
var (
	// ErrMalformed is returned by Open when the bytes are not a valid LP1 page.
	ErrMalformed = errors.New("lp1: malformed page")
	// ErrInvalidValue is returned when a Value cannot be encoded.
	ErrInvalidValue = errors.New("lp1: invalid value")
	// ErrIndexOutOfRange is returned when a Splice index or delete range falls
	// outside the element sequence of the source snapshot.
	ErrIndexOutOfRange = errors.New("lp1: splice index out of range")
	// ErrCapacity is returned when the resulting page would exceed uint32 or the
	// caller supplied byte budget. No partial page is produced.
	ErrCapacity = errors.New("lp1: page capacity exceeded")
)

const (
	headerSize   = 6
	footerSize   = 1
	pageFooter   = 0xff
	unknownCount = 65535
	maxBacklen   = 5
	maxPageSize  = uint64(0xffffffff)
)

// Type identifies the logical type of an element body. Integers and byte
// strings that merely look numeric are distinct types and never auto-convert.
type Type uint8

const (
	TypeInteger Type = iota
	TypeString
)

// Value is an immutable element value. Construct it with Integer or String.
// Byte slices passed to String are copied; Bytes returns a defensive copy.
type Value struct {
	kind Type
	num  int64
	str  []byte
}

// Integer returns the integer Value for n.
func Integer(n int64) Value { return Value{kind: TypeInteger, num: n} }

// String returns a string Value holding a copy of b.
func String(b []byte) Value {
	return Value{kind: TypeString, str: append([]byte(nil), b...)}
}

// Type reports the logical type of the value.
func (v Value) Type() Type { return v.kind }

// Int returns the integer value. It is only meaningful for integer values.
func (v Value) Int() int64 { return v.num }

// Bytes returns a copy of the string payload. It is only meaningful for strings.
func (v Value) Bytes() []byte { return append([]byte(nil), v.str...) }

// EncodeValue produces the shortest LP1 body encoding of v (without a reverse
// length). Integers use the narrowest fixed-width form representing them;
// strings use the shortest length prefix that fits.
func EncodeValue(v Value) ([]byte, error) {
	switch v.kind {
	case TypeInteger:
		return encodeIntBody(v.num), nil
	case TypeString:
		return encodeStringBody(v.str), nil
	default:
		return nil, ErrInvalidValue
	}
}

// EmptyPage returns a freshly allocated, zero-element LP1 page.
func EmptyPage() []byte {
	p := make([]byte, headerSize+footerSize)
	binary.LittleEndian.PutUint32(p[0:4], uint32(headerSize+footerSize))
	p[5] = 0
	p[6] = pageFooter
	return p
}

// encodeIntBody returns the shortest body that represents n.
func encodeIntBody(n int64) []byte {
	if n >= 0 && n <= 127 {
		return []byte{byte(n)}
	}
	if n >= -4096 && n <= 4095 {
		u := uint16(n) & 0x1fff
		return []byte{0xc0 | byte(u>>8), byte(u)}
	}
	if n >= -32768 && n <= 32767 {
		u := uint16(n)
		return []byte{0xf1, byte(u), byte(u >> 8)}
	}
	if n >= -8388608 && n <= 8388607 {
		u := uint32(n)
		return []byte{0xf2, byte(u), byte(u >> 8), byte(u >> 16)}
	}
	if n >= -2147483648 && n <= 2147483647 {
		u := uint32(n)
		return []byte{0xf3, byte(u), byte(u >> 8), byte(u >> 16), byte(u >> 24)}
	}
	u := uint64(n)
	return []byte{
		0xf4,
		byte(u), byte(u >> 8), byte(u >> 16), byte(u >> 24),
		byte(u >> 32), byte(u >> 40), byte(u >> 48), byte(u >> 56),
	}
}

// encodeStringBody returns the shortest length-prefixed body for payload.
func encodeStringBody(payload []byte) []byte {
	n := len(payload)
	switch {
	case n <= 63:
		out := make([]byte, 0, 1+n)
		out = append(out, 0x80|byte(n))
		return append(out, payload...)
	case n <= 4095:
		out := make([]byte, 0, 2+n)
		out = append(out, 0xe0|byte(n>>8), byte(n))
		return append(out, payload...)
	default:
		out := make([]byte, 0, 5+n)
		out = append(out, 0xf0,
			byte(n), byte(n>>8), byte(n>>16), byte(n>>24))
		return append(out, payload...)
	}
}

// encodeElement appends the minimal reverse-length field to a body.
func encodeElement(body []byte) []byte {
	return append(append([]byte(nil), body...), encodeBacklen(len(body))...)
}

// encodeBacklen writes L using the minimum number of 7-bit groups, big-endian:
// the first group carries high bit 0, every later group carries high bit 1.
// At most five groups are emitted.
func encodeBacklen(l int) []byte {
	var groups [5]byte
	n := 0
	for v := l; v != 0; v >>= 7 {
		groups[n] = byte(v & 0x7f)
		n++
	}
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		g := groups[n-1-i]
		if i > 0 {
			g |= 0x80
		}
		out[i] = g
	}
	return out
}
