// Package tmplex implements an incremental lexer for a small template
// language. Templates mix literal text with expressions delimited by
// "{{" and "}}". Inside an expression, parentheses may nest and string
// literals ('...' or "...", with backslash escapes) may appear; a "}}"
// sequence inside a string literal, or while parentheses are unbalanced,
// does not terminate the expression.
//
// The lexer is fed input in arbitrarily sized blocks via Feed and is
// finalized with Close. The mode stack (text / expression / string,
// together with paren depth and string escape state) lives in the Lexer
// value itself, so interrupting input at any byte boundary never loses
// scanner state. Every Token reports its half-open byte range [Start, End)
// in the original input stream.
package tmplex

// Kind classifies tokens.
type Kind int

const (
	Text       Kind = iota // literal template text
	Open                   // "{{"
	Close                  // "}}" at paren depth 0, outside strings
	Whitespace             // whitespace run inside an expression
	Ident                  // identifier inside an expression
	Number                 // numeric literal inside an expression
	String                 // string literal, quotes included
	Punct                  // any other single byte inside an expression
)

var kindNames = [...]string{
	Text:       "Text",
	Open:       "Open",
	Close:      "Close",
	Whitespace: "Whitespace",
	Ident:      "Ident",
	Number:     "Number",
	String:     "String",
	Punct:      "Punct",
}

func (k Kind) String() string {
	if k < 0 || int(k) >= len(kindNames) {
		return "Kind(?)"
	}
	return kindNames[k]
}

// Token is a lexical unit. Start and End are byte offsets into the
// original input stream; the token's bytes are input[Start:End].
type Token struct {
	Kind  Kind
	Start int
	End   int
}

type mode int

const (
	modeText mode = iota
	modeExpr
	modeString
)

// frame is one entry of the mode stack. The bottom frame is always
// modeText. Expression frames track paren depth; string frames track the
// quote byte, the absolute offset of the opening quote, and whether the
// previous consumed byte was a backslash.
type frame struct {
	mode    mode
	depth   int
	quote   byte
	start   int
	escaped bool
}

// Lexer is an incremental template lexer. The zero value is not usable;
// create one with New.
type Lexer struct {
	stack  []frame
	buf    []byte // unconsumed input
	base   int    // absolute offset of buf[0]
	closed bool
}

// New returns a lexer ready to accept input via Feed.
func New() *Lexer {
	return &Lexer{stack: []frame{{mode: modeText}}}
}

// Feed appends one block of input and returns every token completed by
// it. Tokens may also be completed later, once more input arrives or
// Close is called. Feed panics if called after Close.
func (l *Lexer) Feed(p []byte) []Token {
	if l.closed {
		panic("tmplex: Feed after Close")
	}
	l.buf = append(l.buf, p...)
	return l.scan(false)
}

// Close signals end of input and returns the remaining tokens. Any
// unterminated construct (text tail, open string, open expression) is
// flushed as far as the input allows.
func (l *Lexer) Close() []Token {
	l.closed = true
	toks := l.scan(true)
	// An unterminated string's content may already have been consumed
	// by earlier Feed calls; flush its token from the mode stack.
	if top := l.stack[len(l.stack)-1]; top.mode == modeString {
		toks = append(toks, Token{String, top.start, l.base})
		l.stack = l.stack[:len(l.stack)-1]
	}
	return toks
}

func (l *Lexer) scan(final bool) []Token {
	var toks []Token
	i := 0
	for i < len(l.buf) {
		tok, hasTok, n, ok := l.step(l.buf[i:], l.base+i, final)
		if !ok {
			break
		}
		if n <= 0 {
			panic("tmplex: scanner made no progress")
		}
		if hasTok {
			toks = append(toks, tok)
		}
		i += n
	}
	l.buf = l.buf[i:]
	l.base += i
	if len(l.buf) == 0 {
		l.buf = nil
	}
	return toks
}

// step scans one unit from buf, whose first byte sits at absolute offset
// abs. ok == false means the scanner needs more input before it can
// commit to anything (only possible when final is false). A step may
// consume bytes without emitting a token (mode transitions, string
// content), in which case hasTok is false.
func (l *Lexer) step(buf []byte, abs int, final bool) (tok Token, hasTok bool, n int, ok bool) {
	switch l.stack[len(l.stack)-1].mode {
	case modeText:
		return l.stepText(buf, abs, final)
	case modeExpr:
		return l.stepExpr(buf, abs, final)
	default:
		return l.stepString(buf, abs, final)
	}
}

func (l *Lexer) stepText(buf []byte, abs int, final bool) (Token, bool, int, bool) {
	open := -1
	for j := 0; j+1 < len(buf); j++ {
		if buf[j] == '{' && buf[j+1] == '{' {
			open = j
			break
		}
	}
	switch {
	case open == 0:
		l.stack = append(l.stack, frame{mode: modeExpr})
		return Token{Open, abs, abs + 2}, true, 2, true
	case open > 0:
		return Token{Text, abs, abs + open}, true, open, true
	case !final:
		// No "{{" yet, but a later block may supply one (a trailing
		// '{' may be its first byte), and the text token itself may
		// still grow. Wait for more input.
		return Token{}, false, 0, false
	default:
		return Token{Text, abs, abs + len(buf)}, true, len(buf), true
	}
}

func (l *Lexer) stepExpr(buf []byte, abs int, final bool) (Token, bool, int, bool) {
	top := &l.stack[len(l.stack)-1]
	c := buf[0]
	switch {
	case isSpace(c):
		j := 0
		for j < len(buf) && isSpace(buf[j]) {
			j++
		}
		if j == len(buf) && !final {
			return Token{}, false, 0, false
		}
		return Token{Whitespace, abs, abs + j}, true, j, true
	case c == '}':
		if top.depth > 0 {
			// "}}" only closes an expression at paren depth 0.
			return Token{Punct, abs, abs + 1}, true, 1, true
		}
		if len(buf) >= 2 && buf[1] == '}' {
			l.stack = l.stack[:len(l.stack)-1]
			return Token{Close, abs, abs + 2}, true, 2, true
		}
		if len(buf) == 1 && !final {
			return Token{}, false, 0, false
		}
		return Token{Punct, abs, abs + 1}, true, 1, true
	case c == '(':
		top.depth++
		return Token{Punct, abs, abs + 1}, true, 1, true
	case c == ')':
		if top.depth > 0 {
			top.depth--
		}
		return Token{Punct, abs, abs + 1}, true, 1, true
	case c == '"' || c == '\'':
		l.stack = append(l.stack, frame{mode: modeString, quote: c, start: abs})
		return Token{}, false, 1, true
	case isIdentStart(c):
		j := 0
		for j < len(buf) && isIdent(buf[j]) {
			j++
		}
		if j == len(buf) && !final {
			return Token{}, false, 0, false
		}
		return Token{Ident, abs, abs + j}, true, j, true
	case isDigit(c):
		j := 0
		for j < len(buf) && isDigit(buf[j]) {
			j++
		}
		if j < len(buf) && buf[j] == '.' {
			j++
			for j < len(buf) && isDigit(buf[j]) {
				j++
			}
		}
		if j == len(buf) && !final {
			return Token{}, false, 0, false
		}
		return Token{Number, abs, abs + j}, true, j, true
	default:
		return Token{Punct, abs, abs + 1}, true, 1, true
	}
}

func (l *Lexer) stepString(buf []byte, abs int, final bool) (Token, bool, int, bool) {
	top := &l.stack[len(l.stack)-1]
	esc := top.escaped
	j := 0
	for j < len(buf) {
		b := buf[j]
		switch {
		case esc:
			esc = false
		case b == '\\':
			esc = true
		case b == top.quote:
			start := top.start
			l.stack = l.stack[:len(l.stack)-1]
			return Token{String, start, abs + j + 1}, true, j + 1, true
		}
		j++
	}
	// No closing quote in this block: keep the string frame (quote and
	// escape state) on the mode stack and wait for more input.
	top.escaped = esc
	if !final {
		return Token{}, false, len(buf), true
	}
	start := top.start
	l.stack = l.stack[:len(l.stack)-1]
	return Token{String, start, abs + len(buf)}, true, len(buf), true
}

func isSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

func isDigit(b byte) bool {
	return '0' <= b && b <= '9'
}

func isIdentStart(b byte) bool {
	return b == '_' || 'a' <= b && b <= 'z' || 'A' <= b && b <= 'Z'
}

func isIdent(b byte) bool {
	return isIdentStart(b) || isDigit(b)
}
