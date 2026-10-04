// Package lexer implements an incremental (streaming) lexer supporting
// nested block comments, line comments and strings with escape sequences.
//
// Input may be fed in arbitrarily split chunks via Feed; token boundaries
// never depend on chunk boundaries. All positions are raw byte offsets
// into the logical input stream. At end of input (Close), unterminated
// strings and unterminated block comments are reported as distinct errors.
package lexer

// TokenKind classifies tokens.
type TokenKind int

const (
	TokIdent TokenKind = iota
	TokNumber
	TokString
	TokLineComment
	TokBlockComment
	TokPunct
)

func (k TokenKind) String() string {
	switch k {
	case TokIdent:
		return "Ident"
	case TokNumber:
		return "Number"
	case TokString:
		return "String"
	case TokLineComment:
		return "LineComment"
	case TokBlockComment:
		return "BlockComment"
	case TokPunct:
		return "Punct"
	}
	return "Unknown"
}

// Token is a lexed token. Pos and End are raw byte offsets in the input
// stream; Text is the exact source text of the token.
type Token struct {
	Kind TokenKind
	Pos  int
	End  int
	Text string
}

// ErrKind classifies lexer errors.
type ErrKind int

const (
	// ErrUnterminatedString reports a string literal that hits a raw
	// newline or end of input before its closing quote.
	ErrUnterminatedString ErrKind = iota
	// ErrUnterminatedComment reports a block comment that hits end of
	// input before its nesting depth returns to zero.
	ErrUnterminatedComment
	// ErrInvalidChar reports a byte that cannot start any token.
	ErrInvalidChar
)

func (k ErrKind) String() string {
	switch k {
	case ErrUnterminatedString:
		return "UnterminatedString"
	case ErrUnterminatedComment:
		return "UnterminatedComment"
	case ErrInvalidChar:
		return "InvalidChar"
	}
	return "Unknown"
}

// Error is a lexer error. Pos and End are raw byte offsets: Pos is where
// the offending construct starts, End is where scanning gave up.
type Error struct {
	Kind ErrKind
	Pos  int
	End  int
}

// Lexer is an incremental lexer. Feed it chunks of input in any
// fragmentation, then call Close at end of input.
type Lexer struct {
	buf    []byte // unconsumed input
	base   int    // absolute byte offset of buf[0]
	tokens []Token
	errs   []Error
	eof    bool
}

// New returns an empty Lexer.
func New() *Lexer { return &Lexer{} }

// Feed appends a chunk of input and scans all tokens that are complete.
func (l *Lexer) Feed(p []byte) {
	l.buf = append(l.buf, p...)
	l.scanAll()
}

// Close marks end of input. Any construct still open becomes an
// unterminated-string or unterminated-comment error.
func (l *Lexer) Close() {
	l.eof = true
	l.scanAll()
}

// Tokens returns the tokens scanned so far.
func (l *Lexer) Tokens() []Token { return append([]Token(nil), l.tokens...) }

// Errors returns the errors reported so far.
func (l *Lexer) Errors() []Error { return append([]Error(nil), l.errs...) }

// Lex is a one-shot convenience: lexes data as a single chunk.
func Lex(data []byte) ([]Token, []Error) {
	l := New()
	l.Feed(data)
	l.Close()
	return l.Tokens(), l.Errors()
}

func (l *Lexer) scanAll() {
	for len(l.buf) > 0 {
		n := l.scanOne()
		if n <= 0 {
			return // need more input
		}
		l.base += n
		l.buf = l.buf[n:]
	}
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

func isDigit(c byte) bool { return '0' <= c && c <= '9' }

func isIdentStart(c byte) bool {
	return c == '_' || ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z')
}

func isIdentChar(c byte) bool { return isIdentStart(c) || isDigit(c) }

// scanOne scans a single token (or whitespace run) from l.buf and returns
// the number of bytes consumed. It returns 0 when more input is required
// to decide the token boundary.
func (l *Lexer) scanOne() int {
	b := l.buf
	c := b[0]

	switch {
	case isSpace(c):
		n := 0
		for n < len(b) && isSpace(b[n]) {
			n++
		}
		return n

	case isIdentStart(c):
		n := 0
		for n < len(b) && isIdentChar(b[n]) {
			n++
		}
		if n == len(b) && !l.eof {
			return 0 // identifier may continue in the next chunk
		}
		l.emit(TokIdent, n)
		return n

	case isDigit(c):
		return l.scanNumber()

	case c == '"':
		return l.scanString()

	case c == '/':
		if len(b) < 2 {
			if !l.eof {
				return 0 // could become // or /*
			}
			l.emit(TokPunct, 1)
			return 1
		}
		switch b[1] {
		case '/':
			return l.scanLineComment()
		case '*':
			return l.scanBlockComment()
		default:
			l.emit(TokPunct, 1)
			return 1
		}

	case c < 0x20 || c == 0x7f || c >= 0x80:
		l.errs = append(l.errs, Error{Kind: ErrInvalidChar, Pos: l.base, End: l.base + 1})
		return 1

	default: // printable ASCII punctuation
		l.emit(TokPunct, 1)
		return 1
	}
}

func (l *Lexer) scanNumber() int {
	b := l.buf
	n := 0
	for n < len(b) && isDigit(b[n]) {
		n++
	}
	if n == len(b) && !l.eof {
		return 0 // number may continue
	}
	// Optional fractional part: '.' followed by at least one digit.
	if n < len(b) && b[n] == '.' {
		if n+1 >= len(b) {
			if !l.eof {
				return 0 // need the byte after '.'
			}
		} else if isDigit(b[n+1]) {
			n += 2
			for n < len(b) && isDigit(b[n]) {
				n++
			}
			if n == len(b) && !l.eof {
				return 0
			}
		}
	}
	l.emit(TokNumber, n)
	return n
}

func (l *Lexer) scanString() int {
	b := l.buf
	i := 1
	for i < len(b) {
		switch b[i] {
		case '\\':
			if i+1 >= len(b) {
				if !l.eof {
					return 0 // escape target arrives in a later chunk
				}
				l.errs = append(l.errs, Error{Kind: ErrUnterminatedString, Pos: l.base, End: l.base + i + 1})
				return i + 1
			}
			i += 2 // any escaped byte is literal
		case '"':
			l.emit(TokString, i+1)
			return i + 1
		case '\n':
			l.errs = append(l.errs, Error{Kind: ErrUnterminatedString, Pos: l.base, End: l.base + i})
			return i // newline itself is consumed as whitespace
		default:
			i++
		}
	}
	if !l.eof {
		return 0
	}
	l.errs = append(l.errs, Error{Kind: ErrUnterminatedString, Pos: l.base, End: l.base + len(b)})
	return len(b)
}

func (l *Lexer) scanLineComment() int {
	b := l.buf
	i := 2
	for i < len(b) && b[i] != '\n' {
		i++
	}
	if i == len(b) && !l.eof {
		return 0 // newline may arrive in a later chunk
	}
	l.emit(TokLineComment, i) // newline excluded
	return i
}

func (l *Lexer) scanBlockComment() int {
	b := l.buf
	depth := 1
	i := 2
	for i+1 < len(b) {
		if b[i] == '/' && b[i+1] == '*' {
			depth++
			i += 2
			continue
		}
		if b[i] == '*' && b[i+1] == '/' {
			depth--
			i += 2
			if depth == 0 {
				l.emit(TokBlockComment, i)
				return i
			}
			continue
		}
		i++
	}
	if !l.eof {
		return 0
	}
	l.errs = append(l.errs, Error{Kind: ErrUnterminatedComment, Pos: l.base, End: l.base + len(b)})
	return len(b)
}

func (l *Lexer) emit(kind TokenKind, n int) {
	l.tokens = append(l.tokens, Token{
		Kind: kind,
		Pos:  l.base,
		End:  l.base + n,
		Text: string(l.buf[:n]),
	})
}
