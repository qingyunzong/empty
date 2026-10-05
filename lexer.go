// Package lexer implements a streaming lexer supporting nested block
// comments, line comments, and quoted strings with backslash escapes.
//
// Input may be fed in arbitrarily sized chunks via Feed; token positions
// are always reported as byte offsets into the original input stream.
// When the input is closed while a string or block comment is still open,
// the lexer reports a distinct error for each case.
package lexer

import "fmt"

// Kind identifies the category of a Token.
type Kind int

const (
	Ident Kind = iota
	Number
	String
	LineComment
	BlockComment
	Punct
)

func (k Kind) String() string {
	switch k {
	case Ident:
		return "Ident"
	case Number:
		return "Number"
	case String:
		return "String"
	case LineComment:
		return "LineComment"
	case BlockComment:
		return "BlockComment"
	case Punct:
		return "Punct"
	}
	return "Unknown"
}

// Token is a lexical unit. Start and End are byte offsets into the
// original input stream; End is exclusive. Text is the raw source text.
type Token struct {
	Kind  Kind
	Start int
	End   int
	Text  string
}

func (t Token) String() string {
	return fmt.Sprintf("%s(%d:%d %q)", t.Kind, t.Start, t.End, t.Text)
}

// Error describes a lexical error at byte offset Pos.
type Error struct {
	Pos int
	Msg string
}

func (e Error) Error() string {
	return fmt.Sprintf("byte %d: %s", e.Pos, e.Msg)
}

// Error messages reported at end of input or at a stray newline.
const (
	ErrUnterminatedString       = "unterminated string"
	ErrUnterminatedBlockComment = "unterminated block comment"
)

type state int

const (
	stNormal state = iota
	stString
	stLineComment
	stBlockComment
)

// Lexer is a streaming lexer. Feed it input in any chunking, call Close
// at end of input, and pull completed tokens with Next. Errors are
// accumulated and can be retrieved with Errs.
type Lexer struct {
	buf    []byte // unconsumed input; a partial construct is never consumed
	off    int    // absolute byte offset of buf[0]
	state  state
	errs   []Error
	closed bool
}

// New returns a ready-to-use Lexer.
func New() *Lexer { return &Lexer{} }

// Feed appends a chunk of input. Chunks may split the input at any byte
// boundary, including in the middle of tokens, comments, or strings.
func (l *Lexer) Feed(p []byte) { l.buf = append(l.buf, p...) }

// Close signals end of input. Incomplete strings and block comments are
// finalized (with an error recorded) on subsequent Next calls.
func (l *Lexer) Close() { l.closed = true }

// Errs returns the errors recorded so far, in order of occurrence.
func (l *Lexer) Errs() []Error { return l.errs }

// Next returns the next completed token. ok is false when no complete
// token is available: either more input is needed, or the stream is
// closed and drained.
func (l *Lexer) Next() (tok Token, ok bool) {
	switch l.state {
	case stString:
		return l.scanString()
	case stLineComment:
		return l.scanLineComment()
	case stBlockComment:
		return l.scanBlockComment()
	}
	return l.scanNormal()
}

func (l *Lexer) consume(n int) {
	l.buf = l.buf[n:]
	l.off += n
}

func (l *Lexer) emit(k Kind, n int) Token {
	tok := Token{Kind: k, Start: l.off, End: l.off + n, Text: string(l.buf[:n])}
	l.consume(n)
	return tok
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

func isIdentStart(c byte) bool {
	return c == '_' || ('a' <= c && c <= 'z') || ('A' <= c && c <= 'Z')
}

func isIdentPart(c byte) bool {
	return isIdentStart(c) || ('0' <= c && c <= '9')
}

func isDigit(c byte) bool { return '0' <= c && c <= '9' }

func (l *Lexer) scanNormal() (Token, bool) {
	i := 0
	for i < len(l.buf) && isSpace(l.buf[i]) {
		i++
	}
	l.consume(i)
	if len(l.buf) == 0 {
		return Token{}, false
	}
	c := l.buf[0]
	switch {
	case isIdentStart(c):
		j := 1
		for j < len(l.buf) && isIdentPart(l.buf[j]) {
			j++
		}
		if j == len(l.buf) && !l.closed {
			return Token{}, false
		}
		return l.emit(Ident, j), true
	case isDigit(c):
		j := 1
		for j < len(l.buf) && isDigit(l.buf[j]) {
			j++
		}
		if j < len(l.buf) && l.buf[j] == '.' {
			if j+1 == len(l.buf) && !l.closed {
				return Token{}, false
			}
			if j+1 < len(l.buf) && isDigit(l.buf[j+1]) {
				j += 2
				for j < len(l.buf) && isDigit(l.buf[j]) {
					j++
				}
			}
		}
		if j == len(l.buf) && !l.closed {
			return Token{}, false
		}
		return l.emit(Number, j), true
	case c == '"':
		l.state = stString
		return l.scanString()
	case c == '/':
		if len(l.buf) < 2 {
			if !l.closed {
				return Token{}, false
			}
			return l.emit(Punct, 1), true
		}
		switch l.buf[1] {
		case '/':
			l.state = stLineComment
			return l.scanLineComment()
		case '*':
			l.state = stBlockComment
			return l.scanBlockComment()
		}
		return l.emit(Punct, 1), true
	}
	return l.emit(Punct, 1), true
}

// scanString scans l.buf, whose first byte is the opening quote. The
// partial string is never consumed until it completes or is finalized.
func (l *Lexer) scanString() (Token, bool) {
	esc := false
	for i := 1; i < len(l.buf); i++ {
		c := l.buf[i]
		if esc {
			esc = false
			continue
		}
		switch c {
		case '\\':
			esc = true
		case '"':
			l.state = stNormal
			return l.emit(String, i+1), true
		case '\n':
			l.errs = append(l.errs, Error{Pos: l.off, Msg: ErrUnterminatedString})
			l.state = stNormal
			return l.emit(String, i), true
		}
	}
	if !l.closed {
		return Token{}, false
	}
	l.errs = append(l.errs, Error{Pos: l.off, Msg: ErrUnterminatedString})
	l.state = stNormal
	return l.emit(String, len(l.buf)), true
}

// scanLineComment scans l.buf, whose first two bytes are "//".
func (l *Lexer) scanLineComment() (Token, bool) {
	for i := 2; i < len(l.buf); i++ {
		if l.buf[i] == '\n' {
			l.state = stNormal
			return l.emit(LineComment, i), true
		}
	}
	if !l.closed {
		return Token{}, false
	}
	l.state = stNormal
	return l.emit(LineComment, len(l.buf)), true
}

// scanBlockComment scans l.buf, whose first two bytes are "/*".
// Block comments nest: depth is recomputed from the start each call,
// which is cheap because the buffer holds only the current comment.
func (l *Lexer) scanBlockComment() (Token, bool) {
	depth := 1
	for i := 2; i < len(l.buf); i++ {
		if i+1 >= len(l.buf) {
			break
		}
		switch l.buf[i] {
		case '/':
			if l.buf[i+1] == '*' {
				depth++
				i++
			}
		case '*':
			if l.buf[i+1] == '/' {
				depth--
				i++
				if depth == 0 {
					l.state = stNormal
					return l.emit(BlockComment, i+1), true
				}
			}
		}
	}
	if !l.closed {
		return Token{}, false
	}
	l.errs = append(l.errs, Error{Pos: l.off, Msg: ErrUnterminatedBlockComment})
	l.state = stNormal
	return l.emit(BlockComment, len(l.buf)), true
}

// Lex tokenizes input fed as the given chunks and returns all tokens and
// errors. It is a convenience wrapper over the streaming API.
func Lex(chunks ...string) ([]Token, []Error) {
	l := New()
	var toks []Token
	drain := func() {
		for {
			tok, ok := l.Next()
			if !ok {
				return
			}
			toks = append(toks, tok)
		}
	}
	for _, c := range chunks {
		l.Feed([]byte(c))
		drain()
	}
	l.Close()
	drain()
	return toks, l.Errs()
}
