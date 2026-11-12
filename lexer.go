package dataeng

import "fmt"

type tokenKind int

const (
	tokEOF tokenKind = iota
	tokIdent
	tokInt
	tokString
	tokLParen
	tokRParen
	tokEq
	tokLt
	tokLe
	tokAnd
	tokOr
	tokNot
	tokIs
	tokNull
)

type token struct {
	kind tokenKind
	text string
	pos  int
}

type lexer struct {
	src    string
	pos    int
	tokens []token
}

func lex(src string) ([]token, error) {
	l := &lexer{src: src}
	for {
		l.skipSpaces()
		if l.pos >= len(l.src) {
			l.tokens = append(l.tokens, token{kind: tokEOF, pos: l.pos})
			return l.tokens, nil
		}
		start := l.pos
		ch := l.src[l.pos]
		switch {
		case ch == '(':
			l.pos++
			l.emit(tokLParen, "(", start)
		case ch == ')':
			l.pos++
			l.emit(tokRParen, ")", start)
		case ch == '=':
			l.pos++
			l.emit(tokEq, "=", start)
		case ch == '<':
			l.pos++
			if l.pos < len(l.src) && l.src[l.pos] == '=' {
				l.pos++
				l.emit(tokLe, "<=", start)
			} else {
				l.emit(tokLt, "<", start)
			}
		case isDigit(ch):
			for l.pos < len(l.src) && isDigit(l.src[l.pos]) {
				l.pos++
			}
			l.emit(tokInt, l.src[start:l.pos], start)
		case isIdentStart(ch):
			for l.pos < len(l.src) && isIdentPart(l.src[l.pos]) {
				l.pos++
			}
			text := l.src[start:l.pos]
			l.emit(keywordOrIdent(text), text, start)
		case ch == '\'' || ch == '"':
			value, err := l.lexString(ch)
			if err != nil {
				return nil, err
			}
			l.tokens = append(l.tokens, token{kind: tokString, text: value, pos: start})
		default:
			return nil, fmt.Errorf("%w: unexpected character %q at position %d",
				ErrSyntax, string(ch), start)
		}
	}
}

func (l *lexer) emit(kind tokenKind, text string, pos int) {
	l.tokens = append(l.tokens, token{kind: kind, text: text, pos: pos})
}

func (l *lexer) skipSpaces() {
	for l.pos < len(l.src) && isSpace(l.src[l.pos]) {
		l.pos++
	}
}

func (l *lexer) lexString(quote byte) (string, error) {
	start := l.pos
	l.pos++
	var out []byte
	for {
		if l.pos >= len(l.src) {
			return "", fmt.Errorf("%w: unterminated string starting at position %d", ErrSyntax, start)
		}
		ch := l.src[l.pos]
		switch {
		case ch == quote:
			l.pos++
			return string(out), nil
		case ch == '\\':
			l.pos++
			if l.pos >= len(l.src) {
				return "", fmt.Errorf("%w: unterminated escape at position %d", ErrSyntax, start)
			}
			escaped := l.src[l.pos]
			l.pos++
			switch escaped {
			case 'n':
				out = append(out, '\n')
			case 't':
				out = append(out, '\t')
			case 'r':
				out = append(out, '\r')
			case '\\':
				out = append(out, '\\')
			default:
				if escaped == quote {
					out = append(out, quote)
				} else {
					return "", fmt.Errorf("%w: invalid escape \\%c at position %d",
						ErrSyntax, escaped, l.pos-2)
				}
			}
		default:
			out = append(out, ch)
			l.pos++
		}
	}
}

func keywordOrIdent(text string) tokenKind {
	switch lowerASCII(text) {
	case "and":
		return tokAnd
	case "or":
		return tokOr
	case "not":
		return tokNot
	case "is":
		return tokIs
	case "null":
		return tokNull
	default:
		return tokIdent
	}
}

func lowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}

func isDigit(ch byte) bool { return ch >= '0' && ch <= '9' }

func isSpace(ch byte) bool {
	return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r'
}

func isIdentStart(ch byte) bool {
	return ch == '_' ||
		(ch >= 'a' && ch <= 'z') ||
		(ch >= 'A' && ch <= 'Z')
}

func isIdentPart(ch byte) bool {
	return isIdentStart(ch) || isDigit(ch)
}
