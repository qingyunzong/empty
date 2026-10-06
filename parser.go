package jsoncanon

import (
	"fmt"
	"unicode/utf16"
	"unicode/utf8"
)

// ParseError describes a syntax error at a byte offset in the source.
type ParseError struct {
	Offset int
	Msg    string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("parse error at offset %d: %s", e.Offset, e.Msg)
}

// DuplicateKeyError is returned when an object contains the same key twice.
type DuplicateKeyError struct {
	Key string
}

func (e *DuplicateKeyError) Error() string {
	return fmt.Sprintf("duplicate object key %q", e.Key)
}

type parser struct {
	src []byte
	pos int
}

// Parse parses the JSON-with-comments subset: standard JSON plus
// // line comments, /* block comments */ and trailing commas in
// arrays and objects.
func Parse(src []byte) (*Value, error) {
	p := &parser{src: src}
	if err := p.skipWS(); err != nil {
		return nil, err
	}
	v, err := p.parseValue()
	if err != nil {
		return nil, err
	}
	if err := p.skipWS(); err != nil {
		return nil, err
	}
	if p.pos != len(p.src) {
		return nil, p.errf("unexpected trailing content")
	}
	return v, nil
}

func (p *parser) errf(format string, args ...any) *ParseError {
	return &ParseError{Offset: p.pos, Msg: fmt.Sprintf(format, args...)}
}

func (p *parser) skipWS() error {
	for p.pos < len(p.src) {
		switch p.src[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		case '/':
			if p.pos+1 >= len(p.src) {
				return p.errf("unexpected '/'")
			}
			switch p.src[p.pos+1] {
			case '/':
				p.pos += 2
				for p.pos < len(p.src) && p.src[p.pos] != '\n' {
					p.pos++
				}
			case '*':
				start := p.pos
				p.pos += 2
				closed := false
				for p.pos+1 < len(p.src) {
					if p.src[p.pos] == '*' && p.src[p.pos+1] == '/' {
						p.pos += 2
						closed = true
						break
					}
					p.pos++
				}
				if !closed {
					p.pos = start
					return p.errf("unterminated block comment")
				}
			default:
				return p.errf("unexpected character '/'")
			}
		default:
			return nil
		}
	}
	return nil
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func (p *parser) parseValue() (*Value, error) {
	if p.pos >= len(p.src) {
		return nil, p.errf("unexpected end of input")
	}
	start := p.pos
	c := p.src[p.pos]
	var v *Value
	switch {
	case c == '{':
		obj, err := p.parseObject()
		if err != nil {
			return nil, err
		}
		v = obj
	case c == '[':
		arr, err := p.parseArray()
		if err != nil {
			return nil, err
		}
		v = arr
	case c == '"':
		s, err := p.parseString()
		if err != nil {
			return nil, err
		}
		v = &Value{Kind: KindString, Str: s}
	case c == 't':
		if err := p.expectLiteral("true"); err != nil {
			return nil, err
		}
		v = &Value{Kind: KindBool, Bool: true}
	case c == 'f':
		if err := p.expectLiteral("false"); err != nil {
			return nil, err
		}
		v = &Value{Kind: KindBool}
	case c == 'n':
		if err := p.expectLiteral("null"); err != nil {
			return nil, err
		}
		v = &Value{Kind: KindNull}
	case c == '-' || isDigit(c):
		lit, err := p.parseNumber()
		if err != nil {
			return nil, err
		}
		v = &Value{Kind: KindNumber, Num: lit}
	default:
		return nil, p.errf("unexpected character %q", rune(c))
	}
	v.Span = Span{Start: start, End: p.pos}
	return v, nil
}

func (p *parser) expectLiteral(lit string) error {
	if p.pos+len(lit) > len(p.src) || string(p.src[p.pos:p.pos+len(lit)]) != lit {
		return p.errf("invalid literal, expected %q", lit)
	}
	p.pos += len(lit)
	if p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == '_' || c == '$' || c > 0x7f || ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z') || isDigit(c) {
			return p.errf("invalid literal, expected %q", lit)
		}
	}
	return nil
}

func (p *parser) parseObject() (*Value, error) {
	p.pos++ // consume '{'
	v := &Value{Kind: KindObject}
	if err := p.skipWS(); err != nil {
		return nil, err
	}
	if p.pos < len(p.src) && p.src[p.pos] == '}' {
		p.pos++
		return v, nil
	}
	for {
		if err := p.skipWS(); err != nil {
			return nil, err
		}
		if p.pos >= len(p.src) || p.src[p.pos] != '"' {
			return nil, p.errf("expected object key string")
		}
		keyStart := p.pos
		key, err := p.parseString()
		if err != nil {
			return nil, err
		}
		keySpan := Span{Start: keyStart, End: p.pos}
		if err := p.skipWS(); err != nil {
			return nil, err
		}
		if p.pos >= len(p.src) || p.src[p.pos] != ':' {
			return nil, p.errf("expected ':' after object key")
		}
		p.pos++
		if err := p.skipWS(); err != nil {
			return nil, err
		}
		val, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		v.Obj = append(v.Obj, Member{Key: key, KeySpan: keySpan, Value: val})
		if err := p.skipWS(); err != nil {
			return nil, err
		}
		if p.pos >= len(p.src) {
			return nil, p.errf("unterminated object")
		}
		switch p.src[p.pos] {
		case ',':
			p.pos++
			if err := p.skipWS(); err != nil {
				return nil, err
			}
			if p.pos < len(p.src) && p.src[p.pos] == '}' {
				p.pos++ // trailing comma
				return v, nil
			}
		case '}':
			p.pos++
			return v, nil
		default:
			return nil, p.errf("expected ',' or '}' in object")
		}
	}
}

func (p *parser) parseArray() (*Value, error) {
	p.pos++ // consume '['
	v := &Value{Kind: KindArray}
	if err := p.skipWS(); err != nil {
		return nil, err
	}
	if p.pos < len(p.src) && p.src[p.pos] == ']' {
		p.pos++
		return v, nil
	}
	for {
		if err := p.skipWS(); err != nil {
			return nil, err
		}
		el, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		v.Arr = append(v.Arr, el)
		if err := p.skipWS(); err != nil {
			return nil, err
		}
		if p.pos >= len(p.src) {
			return nil, p.errf("unterminated array")
		}
		switch p.src[p.pos] {
		case ',':
			p.pos++
			if err := p.skipWS(); err != nil {
				return nil, err
			}
			if p.pos < len(p.src) && p.src[p.pos] == ']' {
				p.pos++ // trailing comma
				return v, nil
			}
		case ']':
			p.pos++
			return v, nil
		default:
			return nil, p.errf("expected ',' or ']' in array")
		}
	}
}

func (p *parser) parseString() (string, error) {
	p.pos++ // consume opening quote
	var buf []byte
	for {
		if p.pos >= len(p.src) {
			return "", p.errf("unterminated string")
		}
		c := p.src[p.pos]
		switch {
		case c == '"':
			p.pos++
			return string(buf), nil
		case c == '\\':
			p.pos++
			if p.pos >= len(p.src) {
				return "", p.errf("unterminated escape sequence")
			}
			e := p.src[p.pos]
			p.pos++
			switch e {
			case '"':
				buf = append(buf, '"')
			case '\\':
				buf = append(buf, '\\')
			case '/':
				buf = append(buf, '/')
			case 'b':
				buf = append(buf, '\b')
			case 'f':
				buf = append(buf, '\f')
			case 'n':
				buf = append(buf, '\n')
			case 'r':
				buf = append(buf, '\r')
			case 't':
				buf = append(buf, '\t')
			case 'u':
				r, err := p.parseHex4()
				if err != nil {
					return "", err
				}
				switch {
				case r >= 0xD800 && r < 0xDC00: // high surrogate
					if p.pos+1 < len(p.src) && p.src[p.pos] == '\\' && p.src[p.pos+1] == 'u' {
						p.pos += 2
						r2, err := p.parseHex4()
						if err != nil {
							return "", err
						}
						combined := utf16.DecodeRune(r, r2)
						if combined == 0xFFFD {
							return "", p.errf("invalid surrogate pair")
						}
						buf = append(buf, string(combined)...)
					} else {
						return "", p.errf("unpaired high surrogate")
					}
				case r >= 0xDC00 && r < 0xE000:
					return "", p.errf("unpaired low surrogate")
				default:
					buf = append(buf, string(r)...)
				}
			default:
				return "", p.errf("invalid escape sequence '\\%c'", e)
			}
		case c < 0x20:
			return "", p.errf("unescaped control character in string")
		case c < utf8.RuneSelf:
			buf = append(buf, c)
			p.pos++
		default:
			r, size := utf8.DecodeRune(p.src[p.pos:])
			if r == utf8.RuneError && size <= 1 {
				return "", p.errf("invalid UTF-8 in string")
			}
			buf = append(buf, p.src[p.pos:p.pos+size]...)
			p.pos += size
		}
	}
}

func (p *parser) parseHex4() (rune, error) {
	if p.pos+4 > len(p.src) {
		return 0, p.errf("truncated \\u escape")
	}
	var v rune
	for i := 0; i < 4; i++ {
		c := p.src[p.pos+i]
		var d byte
		switch {
		case isDigit(c):
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, p.errf("invalid hex digit in \\u escape")
		}
		v = v*16 + rune(d)
	}
	p.pos += 4
	return v, nil
}

// parseNumber scans a JSON number and returns its exact literal text.
func (p *parser) parseNumber() (string, error) {
	start := p.pos
	if p.pos < len(p.src) && p.src[p.pos] == '-' {
		p.pos++
	}
	if p.pos >= len(p.src) {
		return "", p.errf("invalid number")
	}
	if p.src[p.pos] == '0' {
		p.pos++
	} else if p.src[p.pos] >= '1' && p.src[p.pos] <= '9' {
		for p.pos < len(p.src) && isDigit(p.src[p.pos]) {
			p.pos++
		}
	} else {
		return "", p.errf("invalid number")
	}
	if p.pos < len(p.src) && p.src[p.pos] == '.' {
		p.pos++
		if p.pos >= len(p.src) || !isDigit(p.src[p.pos]) {
			return "", p.errf("invalid number: expected digit after '.'")
		}
		for p.pos < len(p.src) && isDigit(p.src[p.pos]) {
			p.pos++
		}
	}
	if p.pos < len(p.src) && (p.src[p.pos] == 'e' || p.src[p.pos] == 'E') {
		p.pos++
		if p.pos < len(p.src) && (p.src[p.pos] == '+' || p.src[p.pos] == '-') {
			p.pos++
		}
		if p.pos >= len(p.src) || !isDigit(p.src[p.pos]) {
			return "", p.errf("invalid number: expected exponent digit")
		}
		for p.pos < len(p.src) && isDigit(p.src[p.pos]) {
			p.pos++
		}
	}
	return string(p.src[start:p.pos]), nil
}
