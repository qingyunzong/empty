package dataeng

import (
	"fmt"
	"strings"
)

type tokenKind int

const (
	tokEOF tokenKind = iota
	tokNewline
	tokLBracket
	tokRBracket
	tokLBrace
	tokRBrace
	tokEqual
	tokDot
	tokComma
	tokString
	tokWord
)

type token struct {
	kind tokenKind
	text string
	line int
	col  int
}

type lexer struct {
	src  string
	pos  int
	line int
	col  int
}

func newLexer(src string) *lexer {
	return &lexer{src: src, line: 1, col: 1}
}

func (l *lexer) errorf(line, col int, format string, args ...any) error {
	return &ParseError{Line: line, Column: col, Msg: fmt.Sprintf(format, args...)}
}

func (l *lexer) peekByte() byte {
	if l.pos >= len(l.src) {
		return 0
	}
	return l.src[l.pos]
}

func (l *lexer) advance() byte {
	b := l.src[l.pos]
	l.pos++
	if b == '\n' {
		l.line++
		l.col = 1
	} else {
		l.col++
	}
	return b
}

// skipSpaces consumes spaces, tabs, comments and line breaks. It reports
// whether at least one line break was consumed.
func (l *lexer) skipSpaces() bool {
	for l.pos < len(l.src) {
		switch b := l.src[l.pos]; {
		case b == ' ' || b == '\t':
			l.advance()
		case b == '\n', b == '\r':
			// Consume the whole run of blank lines, spaces and comments so
			// consecutive physical newlines become a single token.
			for l.pos < len(l.src) {
				switch l.src[l.pos] {
				case ' ', '\t', '\n', '\r':
					l.advance()
				case '#':
					for l.pos < len(l.src) && l.src[l.pos] != '\n' && l.src[l.pos] != '\r' {
						l.advance()
					}
				default:
					return true
				}
			}
			return true
		default:
			return false
		}
	}
	return false
}

func (l *lexer) next() (token, error) {
	for {
		sawNewline := l.skipSpaces()
		if sawNewline {
			return token{kind: tokNewline, line: l.line, col: l.col}, nil
		}
		if l.pos >= len(l.src) {
			return token{kind: tokEOF, line: l.line, col: l.col}, nil
		}

		line, col := l.line, l.col
		b := l.src[l.pos]
		if b == '#' {
			// A comment runs to the end of its line. Loop again so the
			// following newline is emitted as a proper token.
			for l.pos < len(l.src) && l.src[l.pos] != '\n' && l.src[l.pos] != '\r' {
				l.advance()
			}
			continue
		}

		switch b {
		case '[', ']', '{', '}', '=', '.', ',':
			l.advance()
			var kind tokenKind
			switch b {
			case '[':
				kind = tokLBracket
			case ']':
				kind = tokRBracket
			case '{':
				kind = tokLBrace
			case '}':
				kind = tokRBrace
			case '=':
				kind = tokEqual
			case '.':
				kind = tokDot
			case ',':
				kind = tokComma
			}
			return token{kind: kind, text: string(b), line: line, col: col}, nil
		case '"':
			text, err := l.readString(line, col)
			if err != nil {
				return token{}, err
			}
			return token{kind: tokString, text: text, line: line, col: col}, nil
		}

		if b >= '0' && b <= '9' || ((b == '+' || b == '-') && l.pos+1 < len(l.src) && l.src[l.pos+1] >= '0' && l.src[l.pos+1] <= '9') {
			text := l.readNumber()
			return token{kind: tokWord, text: text, line: line, col: col}, nil
		}

		if isBareChar(b) {
			start := l.pos
			for l.pos < len(l.src) && isBareChar(l.src[l.pos]) {
				l.advance()
			}
			return token{kind: tokWord, text: l.src[start:l.pos], line: line, col: col}, nil
		}

		l.advance()
		return token{}, l.errorf(line, col, "unexpected character %q", b)
	}
}

// readNumber scans a complete numeric literal (decimal, hex, octal, binary,
// float, exponent and underscores) as one word token.
func (l *lexer) readNumber() string {
	start := l.pos
	if l.src[l.pos] == '+' || l.src[l.pos] == '-' {
		l.advance()
	}
	if l.pos+1 < len(l.src) && l.src[l.pos] == '0' {
		switch l.src[l.pos+1] {
		case 'x', 'X', 'o', 'O', 'b', 'B':
			l.advance()
			l.advance()
			for l.pos < len(l.src) && (isHexDigit(l.src[l.pos]) || l.src[l.pos] == '_') {
				l.advance()
			}
			return l.src[start:l.pos]
		}
	}
	for l.pos < len(l.src) && (isBareChar(l.src[l.pos]) || l.src[l.pos] == '.' || l.src[l.pos] == 'e' || l.src[l.pos] == 'E') {
		l.advance()
	}
	return l.src[start:l.pos]
}

func isHexDigit(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
}

func isBareChar(b byte) bool {
	return b == '_' || b == '-' || b == '+' ||
		(b >= 'a' && b <= 'z') ||
		(b >= 'A' && b <= 'Z') ||
		(b >= '0' && b <= '9')
}

// readString parses a basic (double-quoted) string. Only the escapes stated
// in the specification are accepted: \", \\, \n, \r and \t.
func (l *lexer) readString(line, col int) (string, error) {
	l.advance() // opening quote
	var sb strings.Builder
	for {
		if l.pos >= len(l.src) {
			return "", l.errorf(line, col, "unterminated string")
		}
		b := l.src[l.pos]
		if b == '\n' || b == '\r' {
			return "", l.errorf(l.line, l.col, "newline in string; use an escape sequence")
		}
		if b == '"' {
			l.advance()
			return sb.String(), nil
		}
		if b == '\\' {
			escLine, escCol := l.line, l.col
			l.advance()
			if l.pos >= len(l.src) {
				return "", l.errorf(line, col, "unterminated string")
			}
			esc := l.advance()
			switch esc {
			case '"':
				sb.WriteByte('"')
			case '\\':
				sb.WriteByte('\\')
			case 'n':
				sb.WriteByte('\n')
			case 'r':
				sb.WriteByte('\r')
			case 't':
				sb.WriteByte('\t')
			default:
				return "", l.errorf(escLine, escCol, "invalid escape sequence \\%c", esc)
			}
			continue
		}
		if b < 0x20 {
			return "", l.errorf(l.line, l.col, "control character %#x in string", b)
		}
		sb.WriteByte(b)
		l.advance()
	}
}
