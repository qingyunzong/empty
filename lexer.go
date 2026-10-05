// Package tmplex implements an incremental lexer for a small template
// language. The lexer switches between three modes: literal text,
// expressions (delimited by "{{" and "}}") and string literals inside
// expressions. The mode stack survives chunk boundaries, so input may be
// fed in arbitrarily sized pieces and still produce the same token stream
// as a single full scan.
//
// Tokens report byte ranges (Start inclusive, End exclusive) into the
// original input; no source text is copied.
package tmplex

import (
	"bytes"
	"errors"
	"fmt"
)

// Mode is a lexer state. Modes form a stack: text is the bottom, an
// expression pushes ModeExpr, and a string literal pushes ModeString.
type Mode int

const (
	ModeText Mode = iota
	ModeExpr
	ModeString
)

func (m Mode) String() string {
	switch m {
	case ModeText:
		return "text"
	case ModeExpr:
		return "expr"
	case ModeString:
		return "string"
	}
	return "unknown"
}

// TokenKind classifies tokens.
type TokenKind int

const (
	TokenText      TokenKind = iota // literal text outside expressions
	TokenExprOpen                   // "{{"
	TokenExprClose                  // "}}" at paren depth 0
	TokenString                     // quoted string literal, quotes included
	TokenIdent                      // identifier / keyword
	TokenNumber                     // integer or decimal literal
	TokenLParen                     // "("
	TokenRParen                     // ")"
	TokenOp                         // operator (e.g. + - * / == && <=)
	TokenPunct                      // any other single-byte punctuation
)

func (k TokenKind) String() string {
	switch k {
	case TokenText:
		return "text"
	case TokenExprOpen:
		return "expr-open"
	case TokenExprClose:
		return "expr-close"
	case TokenString:
		return "string"
	case TokenIdent:
		return "ident"
	case TokenNumber:
		return "number"
	case TokenLParen:
		return "lparen"
	case TokenRParen:
		return "rparen"
	case TokenOp:
		return "op"
	case TokenPunct:
		return "punct"
	}
	return "unknown"
}

// Token is a lexical unit. Start and End are byte offsets into the
// original input; Start is inclusive, End exclusive.
type Token struct {
	Kind  TokenKind
	Start int
	End   int
}

// Bytes returns the token's source bytes from the full input.
func (t Token) Bytes(src []byte) []byte { return src[t.Start:t.End] }

func (t Token) String() string {
	return fmt.Sprintf("%s[%d:%d]", t.Kind, t.Start, t.End)
}

// Lexer is an incremental template lexer. The zero value is not ready
// for use; create one with NewLexer.
type Lexer struct {
	buf      []byte // unprocessed input bytes
	base     int    // absolute offset of buf[0]
	modes    []Mode // mode stack, bottom is always ModeText
	depth    int    // paren nesting depth inside the current expression
	quote    byte   // active string quote ('"' or '\'')
	escaped  bool   // previous in-string byte was a backslash
	strStart int    // absolute offset of the active string's opening quote
	eof      bool
	tokens   []Token
}

// NewLexer returns a lexer ready for incremental feeding.
func NewLexer() *Lexer {
	return &Lexer{modes: []Mode{ModeText}}
}

// Mode returns the current mode (top of the mode stack).
func (l *Lexer) Mode() Mode { return l.modes[len(l.modes)-1] }

// Depth returns the paren nesting depth of the current expression.
func (l *Lexer) Depth() int { return l.depth }

// Feed appends a chunk of input and returns the tokens completed by it.
// Chunk boundaries are irrelevant to the resulting token stream.
func (l *Lexer) Feed(p []byte) []Token {
	l.buf = append(l.buf, p...)
	l.run()
	return l.drain()
}

// Close signals end of input, flushes any trailing text token and
// reports unterminated expressions or string literals.
func (l *Lexer) Close() ([]Token, error) {
	l.eof = true
	l.run()
	toks := l.drain()
	switch l.Mode() {
	case ModeString:
		return toks, fmt.Errorf("tmplex: unterminated string literal starting at byte %d", l.strStart)
	case ModeExpr:
		return toks, errors.New("tmplex: unterminated expression")
	}
	return toks, nil
}

// Lex tokenizes src in a single pass.
func Lex(src []byte) ([]Token, error) {
	l := NewLexer()
	toks := l.Feed(src)
	rest, err := l.Close()
	return append(toks, rest...), err
}

func (l *Lexer) push(m Mode) { l.modes = append(l.modes, m) }

func (l *Lexer) pop() {
	if len(l.modes) > 1 {
		l.modes = l.modes[:len(l.modes)-1]
	}
}

func (l *Lexer) emit(kind TokenKind, start, end int) {
	l.tokens = append(l.tokens, Token{Kind: kind, Start: start, End: end})
}

func (l *Lexer) consume(n int) {
	l.buf = l.buf[n:]
	l.base += n
}

func (l *Lexer) drain() []Token {
	if len(l.tokens) == 0 {
		return nil
	}
	toks := make([]Token, len(l.tokens))
	copy(toks, l.tokens)
	l.tokens = l.tokens[:0]
	return toks
}

// run lexes until every lex* step reports it needs more input.
func (l *Lexer) run() {
	for {
		var progress bool
		switch l.Mode() {
		case ModeText:
			progress = l.lexText()
		case ModeExpr:
			progress = l.lexExpr()
		case ModeString:
			progress = l.lexString()
		}
		if !progress {
			return
		}
	}
}

// lexText scans literal text up to the next "{{". A text token is only
// completed by an expression open or by EOF, so chunk boundaries can
// never split one.
func (l *Lexer) lexText() bool {
	i := bytes.Index(l.buf, []byte("{{"))
	if i < 0 {
		if l.eof && len(l.buf) > 0 {
			l.emit(TokenText, l.base, l.base+len(l.buf))
			l.consume(len(l.buf))
		}
		return false
	}
	if i > 0 {
		l.emit(TokenText, l.base, l.base+i)
	}
	l.emit(TokenExprOpen, l.base+i, l.base+i+2)
	l.consume(i + 2)
	l.depth = 0
	l.push(ModeExpr)
	return true
}

// lexString scans a string literal body for its closing quote. The
// escape flag and quote byte live in the lexer, so a chunk may end
// mid-string (even right after a backslash) without losing state.
// A "}}" sequence inside a string is never treated as an expression end.
func (l *Lexer) lexString() bool {
	for i := 0; i < len(l.buf); i++ {
		c := l.buf[i]
		if l.escaped {
			l.escaped = false
			continue
		}
		switch c {
		case '\\':
			l.escaped = true
		case l.quote:
			l.emit(TokenString, l.strStart, l.base+i+1)
			l.consume(i + 1)
			l.pop()
			return true
		}
	}
	// No closing quote yet: the scanned bytes carry no further state
	// beyond l.escaped, so they can be dropped from the buffer.
	l.consume(len(l.buf))
	return false
}

func (l *Lexer) lexExpr() bool {
	i := 0
	for i < len(l.buf) && isSpace(l.buf[i]) {
		i++
	}
	if i > 0 {
		l.consume(i)
	}
	if len(l.buf) == 0 {
		return false
	}
	c := l.buf[0]
	switch {
	case c == '}':
		// Need a second byte to decide between "}}" and a lone "}".
		if len(l.buf) < 2 && !l.eof {
			return false
		}
		if len(l.buf) >= 2 && l.buf[1] == '}' && l.depth == 0 {
			l.emit(TokenExprClose, l.base, l.base+2)
			l.consume(2)
			l.pop()
			return true
		}
		// A "}" inside nested parens (or a lone one) is punctuation;
		// it must not terminate the expression.
		l.emit(TokenPunct, l.base, l.base+1)
		l.consume(1)
		return true
	case c == '(':
		l.depth++
		l.emit(TokenLParen, l.base, l.base+1)
		l.consume(1)
		return true
	case c == ')':
		if l.depth > 0 {
			l.depth--
		}
		l.emit(TokenRParen, l.base, l.base+1)
		l.consume(1)
		return true
	case c == '"' || c == '\'':
		l.strStart = l.base
		l.quote = c
		l.escaped = false
		l.consume(1)
		l.push(ModeString)
		return true
	case isDigit(c):
		j := 0
		for j < len(l.buf) && (isDigit(l.buf[j]) || l.buf[j] == '.') {
			j++
		}
		if j == len(l.buf) && !l.eof {
			return false // number may continue in the next chunk
		}
		l.emit(TokenNumber, l.base, l.base+j)
		l.consume(j)
		return true
	case isAlpha(c):
		j := 0
		for j < len(l.buf) && isAlphaNum(l.buf[j]) {
			j++
		}
		if j == len(l.buf) && !l.eof {
			return false // identifier may continue in the next chunk
		}
		l.emit(TokenIdent, l.base, l.base+j)
		l.consume(j)
		return true
	case isTwoCharOpStart(c):
		// Need a second byte to decide between e.g. "=" and "==".
		if len(l.buf) < 2 && !l.eof {
			return false
		}
		if len(l.buf) >= 2 && isTwoCharOp(l.buf[0], l.buf[1]) {
			l.emit(TokenOp, l.base, l.base+2)
			l.consume(2)
			return true
		}
		l.emit(TokenOp, l.base, l.base+1)
		l.consume(1)
		return true
	case isOp(c):
		l.emit(TokenOp, l.base, l.base+1)
		l.consume(1)
		return true
	default:
		l.emit(TokenPunct, l.base, l.base+1)
		l.consume(1)
		return true
	}
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

func isDigit(c byte) bool { return '0' <= c && c <= '9' }

func isAlpha(c byte) bool {
	return c == '_' || ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z')
}

func isAlphaNum(c byte) bool { return isAlpha(c) || isDigit(c) }

// isTwoCharOpStart reports whether c can begin a two-byte operator and
// therefore requires a lookahead byte.
func isTwoCharOpStart(c byte) bool {
	switch c {
	case '=', '!', '<', '>', '&', '|':
		return true
	}
	return false
}

func isTwoCharOp(a, b byte) bool {
	switch string([]byte{a, b}) {
	case "==", "!=", "<=", ">=", "&&", "||":
		return true
	}
	return false
}

func isOp(c byte) bool {
	switch c {
	case '+', '-', '*', '/', '%':
		return true
	}
	return false
}
