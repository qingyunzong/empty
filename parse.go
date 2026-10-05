package permset

import (
	"fmt"
	"math"
	"slices"
	"strconv"
)

// Error describes a syntax error in an expression, located at byte
// offset Pos of the input.
type Error struct {
	Pos int
	Msg string
}

func (e *Error) Error() string {
	return fmt.Sprintf("syntax error at position %d: %s", e.Pos, e.Msg)
}

// node is the AST of a parsed expression.
type node interface{ isNode() }

// litNode is an interval literal; text is its exact source slice.
type litNode struct {
	lo, hi int64
	text   string
}

// nameNode references a named definition.
type nameNode struct{ name string }

// binNode is a binary operation: '|' union, '&' intersection, '-' difference.
type binNode struct {
	op   byte
	l, r node
}

func (litNode) isNode()  {}
func (nameNode) isNode() {}
func (binNode) isNode()  {}

// refsOf collects the names referenced by n, sorted and deduplicated.
func refsOf(n node) []string {
	seen := map[string]bool{}
	var walk func(n node)
	walk = func(n node) {
		switch n := n.(type) {
		case nameNode:
			seen[n.name] = true
		case binNode:
			walk(n.l)
			walk(n.r)
		}
	}
	walk(n)
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	slices.Sort(out)
	return out
}

type tokKind int

const (
	tEOF tokKind = iota
	tLBrack
	tRBrack
	tLParen
	tRParen
	tComma
	tUnion
	tInter
	tMinus
	tNumber
	tIdent
)

type token struct {
	kind tokKind
	pos  int
	text string
}

type parser struct {
	src string
	pos int
	cur token
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
func isAlpha(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

func (p *parser) advance() error {
	for p.pos < len(p.src) && (p.src[p.pos] == ' ' || p.src[p.pos] == '\t' ||
		p.src[p.pos] == '\n' || p.src[p.pos] == '\r') {
		p.pos++
	}
	start := p.pos
	if p.pos >= len(p.src) {
		p.cur = token{kind: tEOF, pos: p.pos}
		return nil
	}
	c := p.src[p.pos]
	single := func(k tokKind) {
		p.pos++
		p.cur = token{kind: k, pos: start, text: p.src[start:p.pos]}
	}
	switch {
	case c == '[':
		single(tLBrack)
	case c == ']':
		single(tRBrack)
	case c == '(':
		single(tLParen)
	case c == ')':
		single(tRParen)
	case c == ',':
		single(tComma)
	case c == '|':
		single(tUnion)
	case c == '&':
		single(tInter)
	case c == '-':
		single(tMinus)
	case isDigit(c):
		for p.pos < len(p.src) && isDigit(p.src[p.pos]) {
			p.pos++
		}
		p.cur = token{kind: tNumber, pos: start, text: p.src[start:p.pos]}
	case isAlpha(c):
		for p.pos < len(p.src) && (isAlpha(p.src[p.pos]) || isDigit(p.src[p.pos])) {
			p.pos++
		}
		p.cur = token{kind: tIdent, pos: start, text: p.src[start:p.pos]}
	default:
		return &Error{Pos: start, Msg: fmt.Sprintf("unexpected character %q", rune(c))}
	}
	return nil
}

// parse parses src into an AST and returns the sorted names it references.
func parse(src string) (node, []string, error) {
	p := &parser{src: src}
	if err := p.advance(); err != nil {
		return nil, nil, err
	}
	n, err := p.parseUnion()
	if err != nil {
		return nil, nil, err
	}
	if p.cur.kind != tEOF {
		return nil, nil, &Error{Pos: p.cur.pos, Msg: fmt.Sprintf("unexpected trailing input %q", p.cur.text)}
	}
	return n, refsOf(n), nil
}

// union := diff ('|' diff)*
func (p *parser) parseUnion() (node, error) {
	l, err := p.parseDiff()
	if err != nil {
		return nil, err
	}
	for p.cur.kind == tUnion {
		if err := p.advance(); err != nil {
			return nil, err
		}
		r, err := p.parseDiff()
		if err != nil {
			return nil, err
		}
		l = binNode{op: '|', l: l, r: r}
	}
	return l, nil
}

// diff := inter ('-' inter)*
func (p *parser) parseDiff() (node, error) {
	l, err := p.parseInter()
	if err != nil {
		return nil, err
	}
	for p.cur.kind == tMinus {
		if err := p.advance(); err != nil {
			return nil, err
		}
		r, err := p.parseInter()
		if err != nil {
			return nil, err
		}
		l = binNode{op: '-', l: l, r: r}
	}
	return l, nil
}

// inter := primary ('&' primary)*
func (p *parser) parseInter() (node, error) {
	l, err := p.parsePrimary()
	if err != nil {
		return nil, err
	}
	for p.cur.kind == tInter {
		if err := p.advance(); err != nil {
			return nil, err
		}
		r, err := p.parsePrimary()
		if err != nil {
			return nil, err
		}
		l = binNode{op: '&', l: l, r: r}
	}
	return l, nil
}

func (p *parser) parsePrimary() (node, error) {
	tok := p.cur
	switch tok.kind {
	case tLParen:
		if err := p.advance(); err != nil {
			return nil, err
		}
		n, err := p.parseUnion()
		if err != nil {
			return nil, err
		}
		if p.cur.kind != tRParen {
			return nil, &Error{Pos: p.cur.pos, Msg: "expected ')'"}
		}
		if err := p.advance(); err != nil {
			return nil, err
		}
		return n, nil
	case tLBrack:
		return p.parseInterval()
	case tIdent:
		if tok.text == "min" || tok.text == "max" {
			return nil, &Error{Pos: tok.pos, Msg: fmt.Sprintf("reserved word %q cannot be used as a set name", tok.text)}
		}
		if err := p.advance(); err != nil {
			return nil, err
		}
		return nameNode{name: tok.text}, nil
	case tEOF:
		return nil, &Error{Pos: tok.pos, Msg: "expected interval, name, or '(' but reached end of input"}
	default:
		return nil, &Error{Pos: tok.pos, Msg: fmt.Sprintf("expected interval, name, or '(' but found %q", tok.text)}
	}
}

// interval := '[' endpoint [',' endpoint] ']'
func (p *parser) parseInterval() (node, error) {
	start := p.cur.pos
	if err := p.advance(); err != nil {
		return nil, err
	}
	lo, err := p.parseEndpoint()
	if err != nil {
		return nil, err
	}
	hi := lo
	if p.cur.kind == tComma {
		if err := p.advance(); err != nil {
			return nil, err
		}
		hi, err = p.parseEndpoint()
		if err != nil {
			return nil, err
		}
	}
	if p.cur.kind != tRBrack {
		return nil, &Error{Pos: p.cur.pos, Msg: "expected ',' or ']' in interval"}
	}
	end := p.cur.pos + 1
	if err := p.advance(); err != nil {
		return nil, err
	}
	if lo > hi {
		return nil, &Error{Pos: end - 1, Msg: fmt.Sprintf("interval lower bound %d exceeds upper bound %d", lo, hi)}
	}
	return litNode{lo: lo, hi: hi, text: p.src[start:end]}, nil
}

// endpoint := ['-'] number | 'min' | 'max'
func (p *parser) parseEndpoint() (int64, error) {
	tok := p.cur
	switch tok.kind {
	case tNumber:
		v, err := strconv.ParseInt(tok.text, 10, 64)
		if err != nil {
			return 0, &Error{Pos: tok.pos, Msg: fmt.Sprintf("integer %q out of 64-bit range", tok.text)}
		}
		if err := p.advance(); err != nil {
			return 0, err
		}
		return v, nil
	case tMinus:
		if err := p.advance(); err != nil {
			return 0, err
		}
		nt := p.cur
		if nt.kind != tNumber {
			return 0, &Error{Pos: nt.pos, Msg: "expected integer after '-'"}
		}
		v, err := strconv.ParseInt("-"+nt.text, 10, 64)
		if err != nil {
			return 0, &Error{Pos: nt.pos, Msg: fmt.Sprintf("integer %q out of 64-bit range", "-"+nt.text)}
		}
		if err := p.advance(); err != nil {
			return 0, err
		}
		return v, nil
	case tIdent:
		if tok.text == "min" {
			if err := p.advance(); err != nil {
				return 0, err
			}
			return math.MinInt64, nil
		}
		if tok.text == "max" {
			if err := p.advance(); err != nil {
				return 0, err
			}
			return math.MaxInt64, nil
		}
		return 0, &Error{Pos: tok.pos, Msg: fmt.Sprintf("expected integer endpoint, found name %q", tok.text)}
	default:
		return 0, &Error{Pos: tok.pos, Msg: "expected integer endpoint"}
	}
}
