// Package canonenc implements a canonical escape encoding for byte strings.
//
// Encoding rules:
//   - Bytes in the must-escape set (control bytes 0x00-0x1F, DEL 0x7F,
//     the escape byte 0x5C itself, and the record delimiter 0xFF) are
//     encoded as two bytes: EscapeByte followed by (b XOR escapeMask).
//   - All other bytes are copied verbatim.
//
// The encoding is canonical: every byte string has exactly one valid
// encoding. Decoders reject non-canonical forms (e.g. escaping a byte
// that does not require escaping) and distinguish truncated input
// (dangling escape at end of stream) from illegal input.
package canonenc

const (
	// EscapeByte introduces a two-byte escape sequence.
	EscapeByte = 0x5C // '\\'
	// DelimiterByte is the record delimiter; it never appears verbatim
	// in encoded output.
	DelimiterByte = 0xFF
	// escapeMask maps a must-escape byte to its escaped payload byte.
	// XOR 0x20 sends 0x00-0x1F to 0x20-0x3F, 0x5C to 0x7C, 0x7F to
	// 0x5F and 0xFF to 0xDF, so a payload byte is never itself a
	// control byte, the escape byte, or the delimiter.
	escapeMask = 0x20
)

// needsEscape reports whether b must be escaped in canonical output.
func needsEscape(b byte) bool {
	switch {
	case b < 0x20: // C0 control bytes
		return true
	case b == 0x7F: // DEL
		return true
	case b == EscapeByte:
		return true
	case b == DelimiterByte:
		return true
	}
	return false
}

// escapePayload returns the second byte of the escape sequence for b.
// It is only meaningful when needsEscape(b) is true.
func escapePayload(b byte) byte { return b ^ escapeMask }

// unescapePayload maps an escape payload byte back to the original byte.
func unescapePayload(b byte) byte { return b ^ escapeMask }

// Encode appends the canonical encoding of src to dst and returns the
// extended slice.
func Encode(dst, src []byte) []byte {
	for _, b := range src {
		if needsEscape(b) {
			dst = append(dst, EscapeByte, escapePayload(b))
		} else {
			dst = append(dst, b)
		}
	}
	return dst
}

// Encoded returns the canonical encoding of src as a new slice.
func Encoded(src []byte) []byte {
	return Encode(make([]byte, 0, len(src)+len(src)/8), src)
}
