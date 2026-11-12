package dataeng

import (
	"bytes"
	"errors"
	"unicode/utf8"
)

// Parse errors. Callers may use errors.Is to classify failures.
var (
	// ErrIncomplete means the input ended inside a value, a string escape, or
	// with an unclosed container: the trailing chunk was truncated.
	ErrIncomplete = errors.New("dataeng: incomplete JSON value (truncated input)")
	// ErrInvalidUTF8 means a string contained bytes that are not valid UTF-8.
	ErrInvalidUTF8 = errors.New("dataeng: string is not valid UTF-8")
	// ErrUnpairedSurrogate means a \u escape introduced a surrogate code unit
	// without its required partner.
	ErrUnpairedSurrogate = errors.New("dataeng: unpaired UTF-16 surrogate in string")
	// ErrInvalidEscape means a string used an unsupported backslash escape.
	ErrInvalidEscape = errors.New("dataeng: invalid string escape")
	// ErrControlCharacter means a raw control byte appeared inside a string.
	ErrControlCharacter = errors.New("dataeng: raw control character in string")
	// ErrSyntax means the byte stream did not follow the JSON grammar.
	ErrSyntax = errors.New("dataeng: invalid JSON syntax")
	// ErrEmptyStream means no JSON value was present at all.
	ErrEmptyStream = errors.New("dataeng: empty JSON stream")
)

var simpleEscapes = map[byte]byte{
	'"':  '"',
	'\\': '\\',
	'/':  '/',
	'b':  '\b',
	'f':  '\f',
	'n':  '\n',
	'r':  '\r',
	't':  '\t',
}

// Option configures a Parser.
type Option func(*Parser)

// WithBudget sets the per-number parsing budget.
func WithBudget(b Budget) Option {
	return func(p *Parser) { p.budget = b }
}

type parseState int

const (
	stTop parseState = iota
	stObjectNeedKey
	stObjectAfterKey
	stObjectAfterColon
	stObjectAfterValue
	stObjectAfterComma
	stArrayAfterValue
	stArrayExpectValue
	stArrayAfterComma
	stString
	stNumber
	stLiteral
)

type frame struct {
	node *Node
	key  string
}

// Parser incrementally parses a stream of concatenated JSON values. It accepts
// arbitrary whitespace between values and retains every duplicate object key.
// Feed may be called with chunks as small as one byte; End reports whether the
// final value was truncated mid-stream.
type Parser struct {
	budget Budget

	state parseState
	stack []frame

	// roots collects every completed top-level value of an object stream.
	roots []*Node

	// String accumulator and sub-state.
	strBuf    bytes.Buffer
	isKey     bool
	pending   bool   // a high surrogate waits for a \u low surrogate
	wantLow   bool   // backslash after the high surrogate has been consumed
	hexDigits []byte // up to four hex digits of an in-progress \u escape
	highSur   uint16
	utfTail   []byte // partial multi-byte UTF-8 sequence spanning chunks
	utfNeed   int    // full length of the in-progress multi-byte sequence
	inEscape  bool   // the byte after a backslash is being processed
	inUnicode bool   // collecting the four hex digits of a \u escape

	// Scalar token accumulator.
	token bytes.Buffer

	err error
}

// NewParser builds a streaming parser. Without options, DefaultBudget applies.
func NewParser(opts ...Option) *Parser {
	p := &Parser{budget: DefaultBudget, state: stTop}
	for _, opt := range opts {
		opt(p)
	}
	return p
}

// Parse is the one-shot convenience wrapper over NewParser/Feed/End for a
// single JSON value or an already-buffered object stream.
func Parse(data []byte, opts ...Option) (*Parser, error) {
	p := NewParser(opts...)
	if err := p.Feed(data); err != nil {
		return p, err
	}
	if err := p.End(); err != nil {
		return p, err
	}
	return p, nil
}

// Feed supplies the next input chunk. It returns the first parse error and
// makes the parser inert; subsequent feeds are no-ops.
func (p *Parser) Feed(chunk []byte) error {
	if p.err != nil {
		return p.err
	}
	for i := 0; i < len(chunk); i++ {
		b := chunk[i]
		switch p.state {
		case stTop:
			switch {
			case isSpace(b):
			case b == '{':
				p.beginComposite(&Node{Kind: KindObject})
			case b == '[':
				p.beginComposite(&Node{Kind: KindArray})
			case b == '"':
				p.startString(false)
			case b == '-' || isDigit(b):
				p.state = stNumber
				p.token.Reset()
				p.token.WriteByte(b)
			case b == 't' || b == 'f' || b == 'n':
				p.state = stLiteral
				p.token.Reset()
				p.token.WriteByte(b)
			default:
				return p.fail(ErrSyntax)
			}

		case stArrayExpectValue:
			switch {
			case isSpace(b):
			case b == ']':
				p.closeComposite()
			default:
				p.beginValue(b)
			}

		case stObjectNeedKey:
			switch {
			case isSpace(b):
			case b == '}':
				p.closeComposite()
			case b == '"':
				p.startString(true)
			default:
				return p.fail(ErrSyntax)
			}

		case stObjectAfterKey:
			if !isSpace(b) {
				if b != ':' {
					return p.fail(ErrSyntax)
				}
				p.state = stObjectAfterColon
			}

		case stObjectAfterColon:
			if isSpace(b) {
				continue
			}
			p.beginValue(b)

		case stObjectAfterValue:
			switch {
			case isSpace(b):
			case b == '}':
				p.closeComposite()
			case b == ',':
				p.state = stObjectAfterComma
			default:
				return p.fail(ErrSyntax)
			}

		case stObjectAfterComma:
			switch {
			case isSpace(b):
			case b == '"':
				p.startString(true)
			default:
				return p.fail(ErrSyntax)
			}

		case stArrayAfterValue:
			switch {
			case isSpace(b):
			case b == ']':
				p.closeComposite()
			case b == ',':
				p.state = stArrayAfterComma
			default:
				return p.fail(ErrSyntax)
			}

		case stArrayAfterComma:
			if isSpace(b) {
				continue
			}
			if b == ']' {
				return p.fail(ErrSyntax)
			}
			p.beginValue(b)

		case stString:
			if err := p.feedString(b, chunk, &i); err != nil {
				return p.fail(err)
			}

		case stNumber:
			if isNumberByte(b) {
				p.token.WriteByte(b)
			} else {
				if err := p.finishNumber(); err != nil {
					return p.fail(err)
				}
				i-- // reprocess the delimiter in the successor state
			}

		case stLiteral:
			if isLiteralByte(b) {
				p.token.WriteByte(b)
			} else {
				if err := p.finishLiteral(); err != nil {
					return p.fail(err)
				}
				i--
			}
		}
	}
	return nil
}

// End must be called once after all chunks. It finalizes the in-flight scalar
// or returns ErrIncomplete when the last value was truncated.
func (p *Parser) End() error {
	if p.err != nil {
		return p.err
	}
	switch p.state {
	case stTop:
		if len(p.roots) == 0 {
			return p.fail(ErrEmptyStream)
		}
		return nil
	case stNumber:
		if err := p.finishNumber(); err != nil {
			return p.fail(err)
		}
	case stLiteral:
		if err := p.finishLiteral(); err != nil {
			return p.fail(err)
		}
	default:
		return p.fail(ErrIncomplete)
	}
	if p.state != stTop {
		return p.fail(ErrIncomplete)
	}
	return nil
}

// Root returns the first parsed top-level value, or nil when none completed.
func (p *Parser) Root() *Node {
	if len(p.roots) == 0 {
		return nil
	}
	return p.roots[0]
}

// Roots returns every top-level value in stream order.
func (p *Parser) Roots() []*Node { return p.roots }

func (p *Parser) fail(err error) error {
	p.err = err
	return err
}

func (p *Parser) startString(asKey bool) {
	p.isKey = asKey
	p.strBuf.Reset()
	p.pending = false
	p.wantLow = false
	p.highSur = 0
	p.hexDigits = p.hexDigits[:0]
	p.utfTail = p.utfTail[:0]
	p.utfNeed = 0
	p.inEscape = false
	p.inUnicode = false
	p.state = stString
}

func (p *Parser) beginValue(b byte) {
	switch {
	case b == '{':
		p.beginComposite(&Node{Kind: KindObject})
	case b == '[':
		p.beginComposite(&Node{Kind: KindArray})
	case b == '"':
		p.startString(false)
	case b == '-' || isDigit(b):
		p.state = stNumber
		p.token.Reset()
		p.token.WriteByte(b)
	default:
		p.state = stLiteral
		p.token.Reset()
		p.token.WriteByte(b)
	}
}

func (p *Parser) beginComposite(node *Node) {
	if len(p.stack) > 0 {
		p.attach(node)
	}
	p.stack = append(p.stack, frame{node: node})
	if node.Kind == KindObject {
		p.state = stObjectNeedKey
	} else {
		p.state = stArrayExpectValue
	}
}

func (p *Parser) closeComposite() {
	top := p.stack[len(p.stack)-1]
	p.stack = p.stack[:len(p.stack)-1]
	if len(p.stack) == 0 {
		p.roots = append(p.roots, top.node)
		p.state = stTop
		return
	}
	p.state = p.parentAfterState()
}

func (p *Parser) parentAfterState() parseState {
	parent := p.stack[len(p.stack)-1].node
	if parent.Kind == KindObject {
		return stObjectAfterValue
	}
	return stArrayAfterValue
}

// attach appends a built node to its parent composite.
func (p *Parser) attach(node *Node) {
	parent := &p.stack[len(p.stack)-1]
	if parent.node.Kind == KindObject {
		parent.node.Members = append(parent.node.Members, Member{Key: parent.key, Value: node})
		p.state = stObjectAfterValue
	} else {
		parent.node.Elems = append(parent.node.Elems, node)
		p.state = stArrayAfterValue
	}
}

func (p *Parser) finishNumber() error {
	num, err := parseNumber(p.token.String(), p.budget)
	if err != nil {
		return err
	}
	p.emitScalar(&Node{Kind: KindNumber, Num: num})
	return nil
}

func (p *Parser) finishLiteral() error {
	text := p.token.String()
	var node *Node
	switch text {
	case "true":
		node = &Node{Kind: KindBool, Bool: true}
	case "false":
		node = &Node{Kind: KindBool, Bool: false}
	case "null":
		node = &Node{Kind: KindNull}
	default:
		return ErrSyntax
	}
	p.emitScalar(node)
	return nil
}

func (p *Parser) emitScalar(node *Node) {
	if len(p.stack) == 0 {
		p.roots = append(p.roots, node)
		p.state = stTop
		return
	}
	p.attach(node)
}

func (p *Parser) finishString() {
	text := p.strBuf.String()
	if p.isKey {
		p.stack[len(p.stack)-1].key = text
		p.state = stObjectAfterKey
		return
	}
	p.emitScalar(&Node{Kind: KindString, Str: text})
}

func isSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

func isNumberByte(b byte) bool {
	return isDigit(b) || b == '.' || b == '-' || b == '+' || b == 'e' || b == 'E'
}

func isLiteralByte(b byte) bool {
	return (b >= 'a' && b <= 'z')
}

// feedString processes one byte inside a string. The index is passed so a
// multi-byte UTF-8 rune can be consumed atomically.
func (p *Parser) feedString(b byte, chunk []byte, i *int) error {
	// Continue an in-progress \u escape or the backslash of a low surrogate.
	if p.inEscape || p.inUnicode {
		return p.feedEscape(b)
	}
	if p.pending {
		// A high surrogate is only legal when immediately followed by \uXXXX.
		if b != '\\' {
			return ErrUnpairedSurrogate
		}
		p.wantLow = true
		p.inEscape = true
		p.pending = false
		return nil
	}

	switch {
	case b == '"':
		if err := p.finishStringChecked(); err != nil {
			return err
		}
		return nil
	case b == '\\':
		p.wantLow = false
		p.inEscape = true
		p.inUnicode = false
		p.hexDigits = p.hexDigits[:0]
		return nil
	case b < 0x20:
		return ErrControlCharacter
	case b < 0x80:
		p.strBuf.WriteByte(b)
		return nil
	default:
		return p.feedMultibyte(b, chunk, i)
	}
}

// finishStringChecked rejects a string that ends while a high surrogate still
// awaits its low partner.
func (p *Parser) finishStringChecked() error {
	if p.pending || p.wantLow || len(p.hexDigits) > 0 {
		return ErrUnpairedSurrogate
	}
	p.finishString()
	return nil
}

// feedMultibyte validates one raw multi-byte UTF-8 rune, retaining partial
// sequences when the rune spans a chunk boundary.
func (p *Parser) feedMultibyte(b byte, chunk []byte, i *int) error {
	if len(p.utfTail) > 0 {
		p.utfTail = append(p.utfTail, b)
		if len(p.utfTail) < p.utfNeed {
			return nil
		}
	} else {
		need := utf8Len(b)
		if need < 0 {
			return ErrInvalidUTF8
		}
		if len(chunk)-*i < need {
			p.utfNeed = need
			p.utfTail = append(p.utfTail[:0], chunk[*i:]...)
			*i = len(chunk) - 1
			return nil
		}
		p.utfNeed = need
	}

	var seq []byte
	if len(p.utfTail) > 0 {
		seq = p.utfTail
	} else {
		seq = chunk[*i : *i+p.utfNeed]
	}
	r, size := utf8.DecodeRune(seq)
	if r == utf8.RuneError && size <= 1 {
		return ErrInvalidUTF8
	}
	p.strBuf.Write(seq[:size])
	if len(p.utfTail) == 0 {
		*i += size - 1
	}
	p.utfTail = p.utfTail[:0]
	p.utfNeed = 0
	return nil
}

// feedEscape handles the byte(s) after a backslash.
func (p *Parser) feedEscape(b byte) error {
	if p.inEscape && len(p.hexDigits) == 0 {
		// First byte after the backslash.
		if b != 'u' {
			p.inEscape = false
			if p.wantLow {
				return ErrUnpairedSurrogate
			}
			decoded, ok := simpleEscapes[b]
			if !ok {
				return ErrInvalidEscape
			}
			p.strBuf.WriteByte(decoded)
			p.wantLow = false
			return nil
		}
		p.inEscape = false
		p.inUnicode = true
		p.hexDigits = p.hexDigits[:0]
		return nil
	}

	if _, ok := hexValue(b); !ok {
		return ErrInvalidEscape
	}
	p.hexDigits = append(p.hexDigits, b)
	if len(p.hexDigits) < 4 {
		return nil
	}

	cu := uint16(0)
	for _, hb := range p.hexDigits {
		v, _ := hexValue(hb)
		cu = cu<<4 | uint16(v)
	}
	p.hexDigits = p.hexDigits[:0]
	p.inUnicode = false

	switch {
	case isHighSurrogate(cu):
		if p.pending {
			return ErrUnpairedSurrogate
		}
		p.highSur = cu
		p.pending = true
		p.wantLow = true
		// The next byte must start a \u low surrogate; feedString enforces
		// that it is a backslash.
		return nil
	case isLowSurrogate(cu):
		if !p.wantLow {
			return ErrUnpairedSurrogate
		}
		r := 0x10000 + rune(p.highSur-0xD800)<<10 + rune(cu-0xDC00)
		var buf [4]byte
		n := utf8.EncodeRune(buf[:], r)
		p.strBuf.Write(buf[:n])
		p.pending = false
		p.wantLow = false
		p.highSur = 0
		return nil
	default:
		if p.wantLow {
			return ErrUnpairedSurrogate
		}
		if p.pending {
			return ErrUnpairedSurrogate
		}
		var buf [4]byte
		n := utf8.EncodeRune(buf[:], rune(cu))
		p.strBuf.Write(buf[:n])
		return nil
	}
}

func isHighSurrogate(cu uint16) bool { return cu >= 0xD800 && cu <= 0xDBFF }

func isLowSurrogate(cu uint16) bool { return cu >= 0xDC00 && cu <= 0xDFFF }

func hexValue(b byte) (byte, bool) {
	switch {
	case b >= '0' && b <= '9':
		return b - '0', true
	case b >= 'a' && b <= 'f':
		return b - 'a' + 10, true
	case b >= 'A' && b <= 'F':
		return b - 'A' + 10, true
	default:
		return 0, false
	}
}

// utf8Len reports the expected rune length from a leading byte.
func utf8Len(lead byte) int {
	switch {
	case lead&0x80 == 0x00:
		return 1
	case lead&0xE0 == 0xC0:
		return 2
	case lead&0xF0 == 0xE0:
		return 3
	case lead&0xF8 == 0xF0:
		return 4
	default:
		return -1
	}
}
