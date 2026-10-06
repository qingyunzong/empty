package norm

import (
	"io"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// parseJSONString decodes the JSON string literal starting at src[pos]
// (which must be '"') and returns the decoded string and the offset just
// past the closing quote.
func parseJSONString(src []byte, pos int) (string, int, error) {
	start := pos
	pos++ // opening quote
	var sb strings.Builder
	for {
		if pos >= len(src) {
			return "", 0, &Error{Msg: "unterminated string", Start: start, End: len(src), src: src}
		}
		c := src[pos]
		switch {
		case c == '"':
			return sb.String(), pos + 1, nil
		case c == '\\':
			escPos := pos
			pos++
			if pos >= len(src) {
				return "", 0, &Error{Msg: "unterminated string", Start: start, End: len(src), src: src}
			}
			e := src[pos]
			pos++
			switch e {
			case '"':
				sb.WriteByte('"')
			case '\\':
				sb.WriteByte('\\')
			case '/':
				sb.WriteByte('/')
			case 'b':
				sb.WriteByte('\b')
			case 'f':
				sb.WriteByte('\f')
			case 'n':
				sb.WriteByte('\n')
			case 'r':
				sb.WriteByte('\r')
			case 't':
				sb.WriteByte('\t')
			case 'u':
				r, np, ok := parseHex4(src, pos)
				if !ok {
					return "", 0, &Error{Msg: "invalid \\u escape in string", Start: escPos, src: src}
				}
				pos = np
				switch {
				case r >= 0xD800 && r < 0xDC00:
					if pos+1 < len(src) && src[pos] == '\\' && src[pos+1] == 'u' {
						if r2, np2, ok := parseHex4(src, pos+2); ok && r2 >= 0xDC00 && r2 < 0xE000 {
							sb.WriteRune(utf16.DecodeRune(r, r2))
							pos = np2
							continue
						}
					}
					return "", 0, &Error{Msg: "lone high surrogate in string", Start: escPos, src: src}
				case r >= 0xDC00 && r < 0xE000:
					return "", 0, &Error{Msg: "lone low surrogate in string", Start: escPos, src: src}
				default:
					sb.WriteRune(r)
				}
			default:
				return "", 0, &Error{Msg: "invalid escape sequence in string", Start: escPos, src: src}
			}
		case c < 0x20:
			return "", 0, &Error{Msg: "unescaped control character in string", Start: pos, src: src}
		case c < 0x80:
			sb.WriteByte(c)
			pos++
		default:
			r, size := utf8.DecodeRune(src[pos:])
			if r == utf8.RuneError && size <= 1 {
				return "", 0, &Error{Msg: "invalid UTF-8 in string", Start: pos, src: src}
			}
			sb.Write(src[pos : pos+size])
			pos += size
		}
	}
}

func parseHex4(src []byte, pos int) (rune, int, bool) {
	if pos+4 > len(src) {
		return 0, pos, false
	}
	var v rune
	for i := 0; i < 4; i++ {
		c := src[pos+i]
		var d byte
		switch {
		case c >= '0' && c <= '9':
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, pos, false
		}
		v = v*16 + rune(d)
	}
	return v, pos + 4, true
}

const hexDigits = "0123456789abcdef"

// writeJSONString writes s as a strict-JSON string literal. The escaping
// matches encoding/json with HTML escaping disabled so output can be
// byte-compared against the standard library reference.
func writeJSONString(w io.Writer, s string) {
	io.WriteString(w, `"`)
	for _, r := range s {
		switch r {
		case '"':
			io.WriteString(w, `\"`)
		case '\\':
			io.WriteString(w, `\\`)
		case '\n':
			io.WriteString(w, `\n`)
		case '\r':
			io.WriteString(w, `\r`)
		case '\t':
			io.WriteString(w, `\t`)
		case 0x2028:
			io.WriteString(w, `\u2028`)
		case 0x2029:
			io.WriteString(w, `\u2029`)
		default:
			if r < 0x20 {
				var buf [6]byte
				buf[0] = '\\'
				buf[1] = 'u'
				buf[2] = '0'
				buf[3] = '0'
				buf[4] = hexDigits[r>>4]
				buf[5] = hexDigits[r&0xF]
				w.Write(buf[:])
			} else {
				io.WriteString(w, string(r))
			}
		}
	}
	io.WriteString(w, `"`)
}
