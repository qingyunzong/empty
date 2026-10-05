package stresc

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Options controls how Encode escapes runes.
type Options struct {
	// EscapeNonASCII escapes every rune above 0x7E as \xHH, \uHHHH or
	// \UHHHHHHHH.
	EscapeNonASCII bool
	// EscapeAll escapes every rune (implies EscapeNonASCII).
	EscapeAll bool
}

// Encode escapes s so that Decode(Encode(s, opts)) == s. Backslash,
// \n, \t, \r and control characters are always escaped; invalid UTF-8
// bytes are escaped as \xHH.
func Encode(s string, opts Options) string {
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			i++
			switch c {
			case '\\':
				b.WriteString(`\\`)
			case '\n':
				b.WriteString(`\n`)
			case '\t':
				b.WriteString(`\t`)
			case '\r':
				b.WriteString(`\r`)
			default:
				if c < 0x20 || c == 0x7f || opts.EscapeAll {
					fmt.Fprintf(&b, `\x%02x`, c)
				} else {
					b.WriteByte(c)
				}
			}
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			fmt.Fprintf(&b, `\x%02x`, s[i])
			i++
			continue
		}
		i += size
		if opts.EscapeAll || (opts.EscapeNonASCII && r > 0x7e) {
			switch {
			case r <= 0xff:
				fmt.Fprintf(&b, `\x%02x`, r)
			case r <= 0xffff:
				fmt.Fprintf(&b, `\u%04x`, r)
			default:
				fmt.Fprintf(&b, `\U%08x`, r)
			}
		} else {
			b.WriteString(string(r))
		}
	}
	return b.String()
}
