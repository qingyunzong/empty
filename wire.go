// Package binmsg implements a protobuf-style binary message format with
// numbered fields, repeated values and nested messages. Unknown fields are
// preserved verbatim and keep their relative order when known fields are
// modified.
package binmsg

import (
	"errors"
	"fmt"
)

// WireType is the low-level encoding kind of a field.
type WireType int

const (
	WireVarint  WireType = 0 // unsigned varint
	WireFixed64 WireType = 1 // 8 bytes, little-endian
	WireBytes   WireType = 2 // varint length prefix + bytes (also nested messages)
	WireFixed32 WireType = 5 // 4 bytes, little-endian
)

func (w WireType) valid() bool {
	switch w {
	case WireVarint, WireFixed64, WireBytes, WireFixed32:
		return true
	}
	return false
}

// Error describes a malformed input. Offset is the byte offset at which the
// problem was detected (for an invalid wire type, the offset of the tag).
type Error struct {
	Offset int
	Msg    string
}

func (e *Error) Error() string {
	return fmt.Sprintf("binmsg: %s at offset %d", e.Msg, e.Offset)
}

// ErrorOffset reports the byte offset carried by err, if any.
func ErrorOffset(err error) (int, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e.Offset, true
	}
	return 0, false
}

// appendVarint appends the canonical varint encoding of v to dst.
func appendVarint(dst []byte, v uint64) []byte {
	for v >= 0x80 {
		dst = append(dst, byte(v)|0x80)
		v >>= 7
	}
	return append(dst, byte(v))
}

// readVarint reads a varint starting at data[off]. It returns the value and
// the offset just past the varint.
func readVarint(data []byte, off int) (uint64, int, error) {
	start := off
	var v uint64
	var shift uint
	for i := 0; i < 10; i++ {
		if off >= len(data) {
			return 0, 0, &Error{Offset: start, Msg: "truncated varint"}
		}
		b := data[off]
		off++
		if i == 9 && b > 1 {
			return 0, 0, &Error{Offset: start, Msg: "varint overflows 64 bits"}
		}
		v |= uint64(b&0x7f) << shift
		if b < 0x80 {
			return v, off, nil
		}
		shift += 7
	}
	return 0, 0, &Error{Offset: start, Msg: "varint overflows 64 bits"}
}
