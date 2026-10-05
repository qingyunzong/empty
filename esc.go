// Package stresc provides string escape encoding and decoding with
// source position mapping.
//
// Supported escapes:
//
//	\xHH         hex escape, code point 0x00-0xFF
//	\uHHHH       Unicode escape, BMP code point; a high surrogate must be
//	             immediately followed by a low-surrogate \u escape
//	\UHHHHHHHH   Unicode escape, full code point range
//	\\ \n \t \r  simple escapes
//
// Decode errors retain the exact half-open byte span of the offending
// source segment. DecodeWithMap additionally returns a SourceMap that
// maps every decoded rune back to the whole source span (a single escape
// sequence or a literal rune) that produced it.
package stresc

import (
	"fmt"
	"unicode/utf16"
	"unicode/utf8"
)

// Span is a half-open byte range [Start, End) in the source string.
type Span struct {
	Start, End int
}

// Error describes a decode failure, retaining the exact source span of
// the offending segment.
type Error struct {
	Msg  string
	Span Span
}

func (e *Error) Error() string {
	return fmt.Sprintf("stresc: %s at [%d,%d)", e.Msg, e.Span.Start, e.Span.End)
}

// SourceMap maps each decoded rune to the source span that produced it.
type SourceMap struct {
	spans []Span
}

// Len returns the number of decoded runes tracked by the map.
func (m *SourceMap) Len() int { return len(m.spans) }

// Lookup returns the source span of the escape sequence (or literal
// bytes) that produced the i-th decoded rune.
func (m *SourceMap) Lookup(runeIndex int) Span { return m.spans[runeIndex] }

// Decode decodes all escapes in src. On failure it returns an *Error
// whose Span pinpoints the offending source segment.
func Decode(src string) (string, error) {
	s, _, derr := DecodeWithMap(src)
	if derr != nil {
		return "", derr
	}
	return s, nil
}

// DecodeWithMap decodes src and also returns a SourceMap relating every
// decoded rune to its originating source span.
func DecodeWithMap(src string) (string, *SourceMap, *Error) {
	var d Decoder
	if err := d.Feed(src, true); err != nil {
		return "", nil, err
	}
	return d.String(), &SourceMap{spans: d.Spans()}, nil
}

// scanEscape decodes one escape sequence at the start of s (s[0] == '\\').
// It reports incomplete == true when s ends in the middle of an escape
// and more input could complete it.
func scanEscape(s string) (n int, r rune, incomplete bool, err *Error) {
	if len(s) < 2 {
		return 0, 0, true, nil
	}
	switch s[1] {
	case 'x':
		if len(s) < 4 {
			return 0, 0, true, nil
		}
		v, ok := parseHex(s[2:4])
		if !ok {
			return 0, 0, false, &Error{Msg: "invalid hex escape", Span: Span{0, 4}}
		}
		return 4, rune(v), false, nil
	case 'u':
		if len(s) < 6 {
			return 0, 0, true, nil
		}
		v, ok := parseHex(s[2:6])
		if !ok {
			return 0, 0, false, &Error{Msg: "invalid unicode escape", Span: Span{0, 6}}
		}
		if v >= 0xD800 && v <= 0xDBFF {
			// High surrogate: must be paired with a low-surrogate escape.
			if len(s) < 7 {
				return 0, 0, true, nil
			}
			if s[6] != '\\' {
				return 0, 0, false, &Error{Msg: "unpaired high surrogate", Span: Span{0, 6}}
			}
			if len(s) < 8 {
				return 0, 0, true, nil
			}
			if s[7] != 'u' {
				return 0, 0, false, &Error{Msg: "unpaired high surrogate", Span: Span{0, 6}}
			}
			if len(s) < 12 {
				return 0, 0, true, nil
			}
			v2, ok := parseHex(s[8:12])
			if !ok {
				return 0, 0, false, &Error{Msg: "invalid unicode escape", Span: Span{6, 12}}
			}
			if v2 < 0xDC00 || v2 > 0xDFFF {
				return 0, 0, false, &Error{Msg: "unpaired high surrogate", Span: Span{0, 12}}
			}
			return 12, utf16.DecodeRune(rune(v), rune(v2)), false, nil
		}
		if v >= 0xDC00 && v <= 0xDFFF {
			return 0, 0, false, &Error{Msg: "unpaired low surrogate", Span: Span{0, 6}}
		}
		return 6, rune(v), false, nil
	case 'U':
		if len(s) < 10 {
			return 0, 0, true, nil
		}
		v, ok := parseHex(s[2:10])
		if !ok {
			return 0, 0, false, &Error{Msg: "invalid unicode escape", Span: Span{0, 10}}
		}
		r := rune(v)
		if r > utf8.MaxRune || utf16.IsSurrogate(r) {
			return 0, 0, false, &Error{Msg: "invalid code point", Span: Span{0, 10}}
		}
		return 10, r, false, nil
	case 'n':
		return 2, '\n', false, nil
	case 't':
		return 2, '\t', false, nil
	case 'r':
		return 2, '\r', false, nil
	case '\\':
		return 2, '\\', false, nil
	default:
		return 0, 0, false, &Error{Msg: fmt.Sprintf("unknown escape \\%c", s[1]), Span: Span{0, 2}}
	}
}

func parseHex(s string) (uint32, bool) {
	var v uint32
	for i := 0; i < len(s); i++ {
		c := s[i]
		var d byte
		switch {
		case '0' <= c && c <= '9':
			d = c - '0'
		case 'a' <= c && c <= 'f':
			d = c - 'a' + 10
		case 'A' <= c && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, false
		}
		v = v<<4 | uint32(d)
	}
	return v, true
}
