// Package esc decodes and encodes strings containing hexadecimal and
// Unicode escape sequences, and tracks the exact source byte range of
// every decoded rune so positions can be mapped back to the input.
//
// Supported escapes:
//
//	\\  \n  \t  \r          simple escapes
//	\xHH                    code point U+00HH (Latin-1 range)
//	\uHHHH                  BMP code point; a high surrogate must be
//	                        immediately followed by a \uDC00-\uDFFF
//	                        low-surrogate escape, forming one rune
//	\UHHHHHHHH              full code point (must be a valid, non-surrogate
//	                        code point <= U+10FFFF)
//
// Every escape produces exactly one rune, so Result.Spans has one entry
// per rune of the decoded text.
package esc

import (
	"fmt"
	"unicode/utf8"
)

// Span is a half-open byte range [Start, End) in the encoded source.
type Span struct {
	Start, End int
}

// Error describes a decode or encode failure. Span holds the exact byte
// range of the offending region in the original input (absolute offsets,
// also across StreamDecoder chunk boundaries).
type Error struct {
	Span Span
	Msg  string
}

func (e *Error) Error() string {
	return fmt.Sprintf("esc: %s at bytes [%d,%d)", e.Msg, e.Span.Start, e.Span.End)
}

// Result is the output of decoding: the decoded text plus, for every rune
// of the text, the source byte range it was decoded from. A rune produced
// by an escape (or a surrogate pair of escapes) maps back to the whole
// escape sequence.
type Result struct {
	Text  string
	Spans []Span // Spans[i] is the source range of the i-th rune of Text.
}

// RuneSpan returns the source span of the i-th decoded rune.
func (r *Result) RuneSpan(i int) Span { return r.Spans[i] }

func isHighSurrogate(cp int) bool { return cp >= 0xD800 && cp <= 0xDBFF }
func isLowSurrogate(cp int) bool  { return cp >= 0xDC00 && cp <= 0xDFFF }

func hexVal(c byte) (int64, bool) {
	switch {
	case c >= '0' && c <= '9':
		return int64(c - '0'), true
	case c >= 'a' && c <= 'f':
		return int64(c-'a') + 10, true
	case c >= 'A' && c <= 'F':
		return int64(c-'A') + 10, true
	}
	return 0, false
}

// parseHex parses n hex digits starting at src[i]. escStart is the offset
// of the escape introducer, used for error spans. base is the absolute
// offset of src[0] in the whole input.
func parseHex(src []byte, i, n, base, escStart int) (v int64, err error, incomplete bool) {
	for k := 0; k < n; k++ {
		if i+k >= len(src) {
			return 0, nil, true
		}
		hv, ok := hexVal(src[i+k])
		if !ok {
			return 0, &Error{
				Span: Span{base + escStart, base + i + k + 1},
				Msg:  fmt.Sprintf("invalid hex digit %q in escape", src[i+k]),
			}, false
		}
		v = v*16 + hv
	}
	return v, nil, false
}

// parseEscape parses one escape sequence starting at src[i] == '\\'.
// It returns the decoded rune and the index just past the escape's source.
// incomplete reports that more input might complete the escape (this
// includes a high surrogate waiting for its low-surrogate half).
func parseEscape(src []byte, i, base int) (r rune, next int, err error, incomplete bool) {
	start := i
	if i+1 >= len(src) {
		return 0, 0, nil, true
	}
	switch src[i+1] {
	case '\\':
		return '\\', i + 2, nil, false
	case 'n':
		return '\n', i + 2, nil, false
	case 't':
		return '\t', i + 2, nil, false
	case 'r':
		return '\r', i + 2, nil, false
	case 'x':
		v, err, inc := parseHex(src, i+2, 2, base, start)
		if inc {
			return 0, 0, nil, true
		}
		if err != nil {
			return 0, 0, err, false
		}
		return rune(v), i + 4, nil, false
	case 'u':
		v, err, inc := parseHex(src, i+2, 4, base, start)
		if inc {
			return 0, 0, nil, true
		}
		if err != nil {
			return 0, 0, err, false
		}
		cp := int(v)
		switch {
		case isHighSurrogate(cp):
			j := i + 6 // a low-surrogate \uHHHH escape must follow
			if j+1 >= len(src) {
				return 0, 0, nil, true
			}
			if src[j] != '\\' || src[j+1] != 'u' {
				return 0, 0, &Error{
					Span: Span{base + start, base + j},
					Msg:  "unpaired high surrogate",
				}, false
			}
			v2, err, inc := parseHex(src, j+2, 4, base, j)
			if inc {
				return 0, 0, nil, true
			}
			if err != nil {
				return 0, 0, err, false
			}
			lo := int(v2)
			if !isLowSurrogate(lo) {
				return 0, 0, &Error{
					Span: Span{base + start, base + j + 6},
					Msg:  "high surrogate not followed by low surrogate",
				}, false
			}
			return 0x10000 + rune((cp-0xD800)<<10) + rune(lo-0xDC00), j + 6, nil, false
		case isLowSurrogate(cp):
			return 0, 0, &Error{
				Span: Span{base + start, base + i + 6},
				Msg:  "unpaired low surrogate",
			}, false
		default:
			return rune(cp), i + 6, nil, false
		}
	case 'U':
		v, err, inc := parseHex(src, i+2, 8, base, start)
		if inc {
			return 0, 0, nil, true
		}
		if err != nil {
			return 0, 0, err, false
		}
		if v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF) {
			return 0, 0, &Error{
				Span: Span{base + start, base + i + 10},
				Msg:  fmt.Sprintf("invalid code point U+%04X", v),
			}, false
		}
		return rune(v), i + 10, nil, false
	default:
		return 0, 0, &Error{
			Span: Span{base + start, base + i + 2},
			Msg:  fmt.Sprintf("unknown escape sequence \\%c", src[i+1]),
		}, false
	}
}

// parsePlain parses one UTF-8 rune starting at src[i].
func parsePlain(src []byte, i, base int) (r rune, next int, err error, incomplete bool) {
	if !utf8.FullRune(src[i:]) {
		return 0, 0, nil, true
	}
	r, size := utf8.DecodeRune(src[i:])
	if r == utf8.RuneError && size == 1 {
		return 0, 0, &Error{
			Span: Span{base + i, base + i + 1},
			Msg:  fmt.Sprintf("invalid UTF-8 byte 0x%02X", src[i]),
		}, false
	}
	return r, i + size, nil, false
}

// decode consumes src, appending decoded runes to text and their absolute
// source spans to spans. It returns the number of consumed bytes. With
// final=false an incomplete trailing escape or UTF-8 sequence is left
// unconsumed; with final=true it is reported as an error.
func decode(src []byte, base int, text *[]byte, spans *[]Span, final bool) (int, error) {
	i := 0
	for i < len(src) {
		var r rune
		var next int
		var err error
		var inc bool
		if src[i] == '\\' {
			r, next, err, inc = parseEscape(src, i, base)
		} else {
			r, next, err, inc = parsePlain(src, i, base)
		}
		if inc {
			if !final {
				break
			}
			msg := "incomplete UTF-8 sequence at end of input"
			if src[i] == '\\' {
				msg = "truncated escape sequence at end of input"
			}
			return i, &Error{Span: Span{base + i, base + len(src)}, Msg: msg}
		}
		if err != nil {
			return i, err
		}
		*text = utf8.AppendRune(*text, r)
		*spans = append(*spans, Span{base + i, base + next})
		i = next
	}
	return i, nil
}

// Decode decodes all escapes in s. The returned Result maps every decoded
// rune back to its exact source byte range. A truncated or malformed
// escape, an unpaired surrogate, or invalid UTF-8 yields an *Error whose
// Span covers the offending region of s.
func Decode(s string) (*Result, error) {
	var text []byte
	var spans []Span
	if _, err := decode([]byte(s), 0, &text, &spans, true); err != nil {
		return nil, err
	}
	return &Result{Text: string(text), Spans: spans}, nil
}

// Encode escapes s so it contains only printable ASCII: backslash and the
// control characters \n, \t, \r use simple escapes, other code points
// below U+0100 use \xHH, BMP code points use \uHHHH, and code points
// above the BMP use \UHHHHHHHH. Decode(Encode(s)) round-trips. s must be
// valid UTF-8; otherwise an *Error spanning the first invalid byte is
// returned.
func Encode(s string) (string, error) {
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			return "", &Error{
				Span: Span{i, i + 1},
				Msg:  fmt.Sprintf("invalid UTF-8 byte 0x%02X", s[i]),
			}
		}
		i += size
	}
	var b []byte
	for _, r := range s {
		switch {
		case r == '\\':
			b = append(b, `\\`...)
		case r == '\n':
			b = append(b, `\n`...)
		case r == '\t':
			b = append(b, `\t`...)
		case r == '\r':
			b = append(b, `\r`...)
		case r >= 0x20 && r < 0x7F:
			b = append(b, byte(r))
		case r < 0x100:
			b = append(b, fmt.Sprintf(`\x%02x`, r)...)
		case r < 0x10000:
			b = append(b, fmt.Sprintf(`\u%04x`, r)...)
		default:
			b = append(b, fmt.Sprintf(`\U%08x`, r)...)
		}
	}
	return string(b), nil
}
