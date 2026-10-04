package permset

import (
	"fmt"
	"slices"
	"strconv"
)

// SyntaxError describes a parse failure at a byte offset in the input.
type SyntaxError struct {
	Pos int
	Msg string
}

func (e *SyntaxError) Error() string {
	return fmt.Sprintf("syntax error at position %d: %s", e.Pos, e.Msg)
}

// AST node kinds (unexported; manipulated via Registry and EvalExpr).
type node interface{ node() }

type lit struct{ lo, hi int64 }
type ref struct{ name string }
type bin struct {
	op   byte // '|', '&', '-'
	l, r node
}

func (lit) node() {}
func (ref) node() {}
func (bin) node() {}

type tokKind int

const (
	tEOF tokKind = iota
	tLBracket
	tRBracket
	tComma
	tPipe
	tAmp
	tMinus
	tLParen
	tRParen
	tNumber
	tIdent
)

type token struct {
	kind tokKind
	pos  int
	text string
}

func (t token) describe() string {
	switch t.kind {
	case tEOF:
		return "end of input"
	case tNumber:
		return fmt.Sprintf("number %q", t.text)
	case tIdent:
		return fmt.Sprintf("name %q", t.text)
	default:
		return fmt.Sprintf("%q", t.text)
	}
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
func isAlpha(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func lex(src string) ([]token, error) {
	var toks []token
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '[' || c == ']' || c == ',' || c == '|' || c == '&' ||
			c == '-' || c == '(' || c == ')':
			kinds := map[byte]tokKind{
				'[': tLBracket, ']': tRBracket, ',': tComma, '|': tPipe,
				'&': tAmp, '-': tMinus, '(': tLParen, ')': tRParen,
			}
			toks = append(toks, token{kind: kinds[c], pos: i, text: src[i : i+1]})
			i++
		case isDigit(c):
			j := i
			for j < len(src) && isDigit(src[j]) {
				j++
			}
			toks = append(toks, token{kind: tNumber, pos: i, text: src[i:j]})
			i = j
		case isAlpha(c):
			j := i
			for j < len(src) && (isAlpha(src[j]) || isDigit(src[j])) {
				j++
			}
			toks = append(toks, token{kind: tIdent, pos: i, text: src[i:j]})
			i = j
		default:
			return nil, &SyntaxError{Pos: i, Msg: fmt.Sprintf("unexpected character %q", rune(c))}
		}
	}
	toks = append(toks, token{kind: tEOF, pos: len(src)})
	return toks, nil
}

// Grammar:
//
//	expr   := term ('|' term)*
//	term   := factor (('&' | '-') factor)*
//	factor := '(' expr ')' | '[' num ',' num ']' | ident
//	num    := '-'? digits
//
// '&' and '-' share precedence and bind tighter than '|'; all are
// left-associative.
type parser struct {
	toks []token
	i    int
}

func parse(src string) (node, error) {
	toks, err := lex(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	n, err := p.parseUnion()
	if err != nil {
		return nil, err
	}
	if t := p.peek(); t.kind != tEOF {
		return nil, &SyntaxError{Pos: t.pos, Msg: fmt.Sprintf("unexpected %s after expression", t.describe())}
	}
	return n, nil
}

func (p *parser) peek() token { return p.toks[p.i] }

func (p *parser) next() token {
	t := p.toks[p.i]
	if t.kind != tEOF {
		p.i++
	}
	return t
}

func (p *parser) expect(k tokKind, what string) error {
	if t := p.peek(); t.kind != k {
		return &SyntaxError{Pos: t.pos, Msg: fmt.Sprintf("expected %s, got %s", what, t.describe())}
	}
	p.next()
	return nil
}

func (p *parser) parseUnion() (node, error) {
	l, err := p.parseTerm()
	if err != nil {
		return nil, err
	}
	for p.peek().kind == tPipe {
		p.next()
		r, err := p.parseTerm()
		if err != nil {
			return nil, err
		}
		l = bin{op: '|', l: l, r: r}
	}
	return l, nil
}

func (p *parser) parseTerm() (node, error) {
	l, err := p.parseFactor()
	if err != nil {
		return nil, err
	}
	for {
		k := p.peek().kind
		if k != tAmp && k != tMinus {
			return l, nil
		}
		op := p.next().text[0]
		r, err := p.parseFactor()
		if err != nil {
			return nil, err
		}
		l = bin{op: op, l: l, r: r}
	}
}

func (p *parser) parseFactor() (node, error) {
	t := p.peek()
	switch t.kind {
	case tLParen:
		p.next()
		n, err := p.parseUnion()
		if err != nil {
			return nil, err
		}
		if err := p.expect(tRParen, "')'"); err != nil {
			return nil, err
		}
		return n, nil
	case tLBracket:
		return p.parseInterval()
	case tIdent:
		p.next()
		return ref{name: t.text}, nil
	default:
		return nil, &SyntaxError{Pos: t.pos, Msg: fmt.Sprintf("expected interval, name, or '(', got %s", t.describe())}
	}
}

func (p *parser) parseInterval() (node, error) {
	start := p.next() // consume '['
	lo, err := p.parseNumber()
	if err != nil {
		return nil, err
	}
	if err := p.expect(tComma, "','"); err != nil {
		return nil, err
	}
	hi, err := p.parseNumber()
	if err != nil {
		return nil, err
	}
	if err := p.expect(tRBracket, "']'"); err != nil {
		return nil, err
	}
	if lo > hi {
		return nil, &SyntaxError{Pos: start.pos, Msg: fmt.Sprintf("invalid interval [%d,%d]: lower bound exceeds upper bound", lo, hi)}
	}
	return lit{lo: lo, hi: hi}, nil
}

func (p *parser) parseNumber() (int64, error) {
	neg := false
	if p.peek().kind == tMinus {
		p.next()
		neg = true
	}
	t := p.peek()
	if t.kind != tNumber {
		return 0, &SyntaxError{Pos: t.pos, Msg: fmt.Sprintf("expected integer, got %s", t.describe())}
	}
	p.next()
	s := t.text
	if neg {
		s = "-" + s
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, &SyntaxError{Pos: t.pos, Msg: fmt.Sprintf("integer %q out of 64-bit range", s)}
	}
	return v, nil
}

// collectRefs returns the sorted, de-duplicated names referenced by n.
func collectRefs(n node) []string {
	var out []string
	var walk func(n node)
	walk = func(n node) {
		switch n := n.(type) {
		case ref:
			out = append(out, n.name)
		case bin:
			walk(n.l)
			walk(n.r)
		}
	}
	walk(n)
	return sortedUnique(out)
}

func sortedUnique(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	slices.Sort(out)
	k := 0
	for _, s := range out {
		if k == 0 || out[k-1] != s {
			out[k] = s
			k++
		}
	}
	return out[:k]
}
