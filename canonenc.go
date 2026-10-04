// Package canonenc implements a canonical escape codec for arbitrary bytes.
//
// Encoding rules (canonical form):
//   - Bytes in the must-escape set are written as '%' followed by two
//     uppercase hexadecimal digits.
//   - The must-escape set is: control bytes 0x00-0x1F, DEL (0x7F), and the
//     escape byte '%' itself. This covers the usual record delimiters
//     (NUL, TAB, LF, CR) as well as every other control byte.
//   - Every other byte is emitted verbatim.
//
// Decoding is strict: any input that decodes to the same plaintext but is
// not in canonical form is rejected. In particular, the decoder rejects
// lowercase hex escapes, escapes of bytes outside the must-escape set,
// bare (unescaped) must-escape bytes, and non-hex escape digits.
//
// Truncated input is reported distinctly from malformed input: a dangling
// escape at the end of input yields ErrIncomplete, while any structural
// violation yields an error wrapping ErrInvalid.
package canonenc

import (
	"errors"
	"fmt"
)

// EscapeByte introduces an escape sequence.
const EscapeByte = '%'

// ErrInvalid reports a structurally malformed or non-canonical encoding.
var ErrInvalid = errors.New("canonenc: invalid or non-canonical encoding")

// ErrIncomplete reports input that ends in the middle of an escape
// sequence. It is a truncation signal, not a malformed-input signal:
// appending more bytes could still yield a valid canonical encoding.
var ErrIncomplete = errors.New("canonenc: incomplete escape sequence (truncated input)")

const upperHex = "0123456789ABCDEF"

// MustEscape reports whether b is required to be escaped in canonical form.
func MustEscape(b byte) bool {
	return b < 0x20 || b == 0x7F || b == EscapeByte
}

// EncodedLen returns the maximum encoded length for n plaintext bytes.
func EncodedLen(n int) int { return 3 * n }

// Encode appends the canonical encoding of src to dst and returns the
// extended slice.
func Encode(dst, src []byte) []byte {
	for _, b := range src {
		if MustEscape(b) {
			dst = append(dst, EscapeByte, upperHex[b>>4], upperHex[b&0x0F])
		} else {
			dst = append(dst, b)
		}
	}
	return dst
}

// EncodeString returns the canonical encoding of src as a new byte slice.
func EncodeString(src []byte) []byte {
	return Encode(make([]byte, 0, len(src)+len(src)/4), src)
}

func unhex(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// decodeOne decodes a single logical unit starting at src[i]. It returns
// the decoded byte and the number of input bytes consumed. ok is false if
// the unit is incomplete (truncated); err is non-nil if it is malformed
// or non-canonical.
func decodeOne(src []byte, i int) (b byte, n int, ok bool, err error) {
	c := src[i]
	if c != EscapeByte {
		if MustEscape(c) {
			return 0, 0, false, fmt.Errorf("%w: bare must-escape byte 0x%02X at offset %d", ErrInvalid, c, i)
		}
		return c, 1, true, nil
	}
	if i+1 >= len(src) {
		return 0, 0, false, nil // lone '%' at end: incomplete
	}
	if i+2 >= len(src) {
		// One digit available; validate it eagerly so malformed input is
		// reported as invalid rather than incomplete.
		if _, good := unhex(src[i+1]); !good {
			return 0, 0, false, fmt.Errorf("%w: non-hex escape digit 0x%02X at offset %d", ErrInvalid, src[i+1], i+1)
		}
		return 0, 0, false, nil // "%X" at end: incomplete
	}
	hi, okHi := unhex(src[i+1])
	lo, okLo := unhex(src[i+2])
	if !okHi || !okLo {
		bad := src[i+1]
		off := i + 1
		if okHi {
			bad = src[i+2]
			off = i + 2
		}
		return 0, 0, false, fmt.Errorf("%w: non-hex escape digit 0x%02X at offset %d", ErrInvalid, bad, off)
	}
	if src[i+1] >= 'a' || src[i+2] >= 'a' {
		return 0, 0, false, fmt.Errorf("%w: lowercase hex escape at offset %d (non-canonical)", ErrInvalid, i)
	}
	v := hi<<4 | lo
	if !MustEscape(v) {
		return 0, 0, false, fmt.Errorf("%w: escape of non-must-escape byte 0x%02X at offset %d (non-canonical)", ErrInvalid, v, i)
	}
	return v, 3, true, nil
}

// Decode appends the decoding of src to dst and returns the extended
// slice. src must be a complete canonical encoding: a dangling escape at
// the end of src yields ErrIncomplete, and any malformed or non-canonical
// construct yields an error wrapping ErrInvalid.
func Decode(dst, src []byte) ([]byte, error) {
	for i := 0; i < len(src); {
		b, n, ok, err := decodeOne(src, i)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fmt.Errorf("%w at offset %d", ErrIncomplete, i)
		}
		dst = append(dst, b)
		i += n
	}
	return dst, nil
}

// DecodeString decodes a complete canonical encoding into a new byte slice.
func DecodeString(src []byte) ([]byte, error) {
	return Decode(make([]byte, 0, len(src)), src)
}

// Valid reports whether src is a complete canonical encoding.
func Valid(src []byte) bool {
	_, err := DecodeString(src)
	return err == nil
}
