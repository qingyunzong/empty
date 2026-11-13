package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

func isXMLSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

func (p *parser) skipSpaces() {
	for p.pos < len(p.src) && isXMLSpace(p.src[p.pos]) {
		p.pos++
	}
}

func (p *parser) skipBOM() {
	if bytes.HasPrefix(p.src, []byte{0xef, 0xbb, 0xbf}) {
		p.pos = 3
	}
}

func (p *parser) has(prefix string) bool {
	return bytes.HasPrefix(p.src[p.pos:], []byte(prefix))
}

func (p *parser) peek() byte {
	if p.pos >= len(p.src) {
		return 0
	}
	return p.src[p.pos]
}

func (p *parser) eof() bool {
	return p.pos >= len(p.src)
}

// scanNameBytes scans an XML Name. The caller is responsible for the
// namespace-aware QName checks.
func scanNameBytes(data []byte, pos *int) (string, error) {
	start := *pos
	if *pos >= len(data) {
		return "", errors.New("expected a name")
	}
	r, size := utf8.DecodeRune(data[*pos:])
	if r == utf8.RuneError && size == 1 {
		return "", errors.New("invalid UTF-8 in name")
	}
	if !isNameStartChar(r) {
		return "", errors.New("expected a name")
	}
	*pos += size
	for *pos < len(data) {
		r, size = utf8.DecodeRune(data[*pos:])
		if r == utf8.RuneError && size == 1 {
			return "", errors.New("invalid UTF-8 in name")
		}
		if !isNameChar(r) {
			break
		}
		*pos += size
	}
	return string(data[start:*pos]), nil
}

func (p *parser) scanName() (string, error) {
	name, err := scanNameBytes(p.src, &p.pos)
	if err != nil {
		return "", p.errf(ErrMalformed, p.pos, "%v", err)
	}
	return name, nil
}

func isNameStartChar(r rune) bool {
	if r == ':' || r == '_' {
		return true
	}
	if r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' {
		return true
	}
	if r < 0x80 {
		return false
	}
	return unicode.IsLetter(r)
}

func isNameChar(r rune) bool {
	if isNameStartChar(r) {
		return true
	}
	if r == '-' || r == '.' || r >= '0' && r <= '9' {
		return true
	}
	if r < 0x80 {
		return false
	}
	return unicode.IsDigit(r) || unicode.Is(unicode.Mn, r) ||
		unicode.Is(unicode.Mc, r) || unicode.Is(unicode.Me, r)
}

func validNCName(name string) bool {
	if name == "" {
		return false
	}
	r, size := utf8.DecodeRuneInString(name)
	if r == utf8.RuneError && size == 1 {
		return false
	}
	if !isNameStartChar(r) || r == ':' {
		return false
	}
	for rest := name[size:]; len(rest) > 0; {
		r, size = utf8.DecodeRuneInString(rest)
		if r == utf8.RuneError && size == 1 {
			return false
		}
		if !isNameChar(r) || r == ':' {
			return false
		}
		rest = rest[size:]
	}
	return true
}

func (p *parser) splitQName(raw string, offset int) (prefix, local string, err error) {
	first := strings.IndexByte(raw, ':')
	if first < 0 {
		if !validNCName(raw) {
			return "", "", p.errf(ErrMalformed, offset, "invalid name %q", raw)
		}
		return "", raw, nil
	}
	if first == 0 || first == len(raw)-1 || strings.IndexByte(raw[first+1:], ':') >= 0 {
		return "", "", p.errf(ErrMalformed, offset, "invalid qualified name %q", raw)
	}
	prefix, local = raw[:first], raw[first+1:]
	if !validNCName(prefix) || !validNCName(local) {
		return "", "", p.errf(ErrMalformed, offset, "invalid qualified name %q", raw)
	}
	return prefix, local, nil
}

func validXMLChar(r rune) bool {
	return r == 0x09 || r == 0x0a || r == 0x0d ||
		r >= 0x20 && r <= 0xd7ff ||
		r >= 0xe000 && r <= 0xfffd ||
		r >= 0x10000 && r <= 0x10ffff
}

func validateXMLString(s string) error {
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			return fmt.Errorf("invalid UTF-8 at byte %d", i)
		}
		if !validXMLChar(r) {
			return fmt.Errorf("illegal XML character %U at byte %d", r, i)
		}
		i += size
	}
	return nil
}

func normalizeLineEndings(s string) string {
	if !strings.ContainsRune(s, '\r') {
		return s
	}
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\r", "\n")
}

func builtinEntity(name string) (string, bool) {
	switch name {
	case "amp":
		return "&", true
	case "lt":
		return "<", true
	case "gt":
		return ">", true
	case "apos":
		return "'", true
	case "quot":
		return `"`, true
	default:
		return "", false
	}
}

// decodeReference decodes a reference beginning at data[start], which must be
// '&'. For a character reference it returns the replacement text and an empty
// entity name. For a named entity it returns the name and empty text.
func decodeReference(data []byte, start int) (text, name string, next int, err error) {
	if start >= len(data) || data[start] != '&' {
		return "", "", start, errors.New("expected '&'")
	}
	i := start + 1
	if i >= len(data) {
		return "", "", i, errors.New("incomplete reference")
	}
	if data[i] == '#' {
		i++
		base := 10
		if i < len(data) && data[i] == 'x' {
			base = 16
			i++
		}
		digits := i
		for i < len(data) && isBaseDigit(data[i], base) {
			i++
		}
		if digits == i {
			return "", "", i, errors.New("character reference has no digits")
		}
		if i >= len(data) || data[i] != ';' {
			return "", "", i, errors.New("character reference has no semicolon")
		}
		n, parseErr := parseUint(data[digits:i], base)
		if parseErr != nil || n > 0x10ffff || !validXMLChar(rune(n)) {
			return "", "", i, errors.New("invalid character reference")
		}
		return string(rune(n)), "", i + 1, nil
	}

	nameStart := i
	r, size := utf8.DecodeRune(data[i:])
	if r == utf8.RuneError && size == 1 {
		return "", "", i, errors.New("invalid UTF-8 in entity name")
	}
	if !isNameStartChar(r) {
		return "", "", i, errors.New("invalid entity name")
	}
	i += size
	for i < len(data) {
		r, size = utf8.DecodeRune(data[i:])
		if r == utf8.RuneError && size == 1 {
			return "", "", i, errors.New("invalid UTF-8 in entity name")
		}
		if !isNameChar(r) {
			break
		}
		i += size
	}
	if i >= len(data) || data[i] != ';' {
		return "", "", i, errors.New("entity reference has no semicolon")
	}
	return "", string(data[nameStart:i]), i + 1, nil
}

func isBaseDigit(b byte, base int) bool {
	if b >= '0' && b <= '9' {
		return true
	}
	if base == 16 {
		return b >= 'a' && b <= 'f' || b >= 'A' && b <= 'F'
	}
	return false
}

func parseUint(digits []byte, base int) (uint64, error) {
	var n uint64
	for _, b := range digits {
		var d uint64
		switch {
		case b >= '0' && b <= '9':
			d = uint64(b - '0')
		case b >= 'a' && b <= 'f':
			d = uint64(b-'a') + 10
		case b >= 'A' && b <= 'F':
			d = uint64(b-'A') + 10
		default:
			return 0, errors.New("invalid digit")
		}
		if d >= uint64(base) {
			return 0, errors.New("invalid digit")
		}
		limit := ^uint64(0)
		if n > (limit-d)/uint64(base) {
			return 0, errors.New("character reference is too large")
		}
		n = n*uint64(base) + d
	}
	return n, nil
}
