package intfold

import (
	"fmt"
	"strconv"
	"strings"
)

// Parse parses an integer expression. Grammar (loosest binding first):
//
//	cond   = or   [ "?" cond ":" cond ]
//	or     = and  { "||" and }
//	and    = cmp  { "&&" cmp }
//	cmp    = add  { ("=="|"!="|"<"|"<="|">"|">=") add }
//	add    = mul  { ("+"|"-") mul }
//	mul    = un   { ("*"|"/"|"%") un }
//	un     = {"-"|"!"} primary
//	primary= number | ident | "(" cond ")"
//
// Literals are parsed as 64-bit and wrapped to int32.
func Parse(src string) (*Expr, error) {
	p := &parser{src: src}
	if err := p.lex(); err != nil {
		return nil, err
	}
	e, err := p.parseCond()
	if err != nil {
		return nil, err
	}
	if p.tok.kind != tkEOF {
		return nil, fmt.Errorf("unexpected %q at offset %d", p.tok.text, p.tok.lo)
	}
	return e, nil
}

type tokKind int

const (
	tkEOF tokKind = iota
	tkNum
	tkIdent
	tkOp
)

type token struct {
	kind tokKind
	text string
	lo   int
	hi   int
}

type parser struct {
	src  string
	toks []token
	pos  int
	tok  token
}

func (p *parser) lex() error {
	s := p.src
	i := 0
	push := func(k tokKind, text string, lo, hi int) {
		p.toks = append(p.toks, token{kind: k, text: text, lo: lo, hi: hi})
	}
	for i < len(s) {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c >= '0' && c <= '9':
			j := i
			for j < len(s) && s[j] >= '0' && s[j] <= '9' {
				j++
			}
			push(tkNum, s[i:j], i, j)
			i = j
		case c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'):
			j := i
			for j < len(s) && (s[j] == '_' || s[j] >= '0' && s[j] <= '9' ||
				s[j] >= 'a' && s[j] <= 'z' || s[j] >= 'A' && s[j] <= 'Z') {
				j++
			}
			push(tkIdent, s[i:j], i, j)
			i = j
		default:
			two := ""
			if i+1 < len(s) {
				two = s[i : i+2]
			}
			switch two {
			case "&&", "||", "==", "!=", "<=", ">=":
				push(tkOp, two, i, i+2)
				i += 2
				continue
			}
			switch c {
			case '+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '(', ')':
				push(tkOp, string(c), i, i+1)
				i++
			default:
				return fmt.Errorf("illegal character %q at offset %d", c, i)
			}
		}
	}
	push(tkEOF, "", len(s), len(s))
	p.tok = p.toks[0]
	return nil
}

func (p *parser) next() {
	p.pos++
	p.tok = p.toks[p.pos]
}

func (p *parser) expect(text string) (token, error) {
	if p.tok.kind != tkOp || p.tok.text != text {
		return token{}, fmt.Errorf("expected %q, got %q at offset %d", text, p.tok.text, p.tok.lo)
	}
	t := p.tok
	p.next()
	return t, nil
}

func (p *parser) parseCond() (*Expr, error) {
	c, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	if p.tok.kind == tkOp && p.tok.text == "?" {
		p.next()
		t, err := p.parseCond()
		if err != nil {
			return nil, err
		}
		colon, err := p.expect(":")
		if err != nil {
			return nil, err
		}
		_ = colon
		f, err := p.parseCond()
		if err != nil {
			return nil, err
		}
		return &Expr{Kind: Cond, Span: Span{c.Span.Lo, f.Span.Hi}, C: c, T: t, F: f}, nil
	}
	return c, nil
}

func (p *parser) parseBinary(next func() (*Expr, error), ops map[string]Op) func() (*Expr, error) {
	return func() (*Expr, error) {
		l, err := next()
		if err != nil {
			return nil, err
		}
		for p.tok.kind == tkOp {
			op, ok := ops[p.tok.text]
			if !ok {
				break
			}
			p.next()
			r, err := next()
			if err != nil {
				return nil, err
			}
			l = &Expr{Kind: Binary, Op: op, Span: Span{l.Span.Lo, r.Span.Hi}, L: l, R: r}
		}
		return l, nil
	}
}

func (p *parser) parseOr() (*Expr, error) {
	return p.parseBinary(p.parseAnd, map[string]Op{"||": OpOr})()
}

func (p *parser) parseAnd() (*Expr, error) {
	return p.parseBinary(p.parseCmp, map[string]Op{"&&": OpAnd})()
}

func (p *parser) parseCmp() (*Expr, error) {
	return p.parseBinary(p.parseAdd, map[string]Op{
		"==": OpEq, "!=": OpNe, "<": OpLt, "<=": OpLe, ">": OpGt, ">=": OpGe,
	})()
}

func (p *parser) parseAdd() (*Expr, error) {
	return p.parseBinary(p.parseMul, map[string]Op{"+": OpAdd, "-": OpSub})()
}

func (p *parser) parseMul() (*Expr, error) {
	return p.parseBinary(p.parseUn, map[string]Op{"*": OpMul, "/": OpDiv, "%": OpMod})()
}

func (p *parser) parseUn() (*Expr, error) {
	if p.tok.kind == tkOp && (p.tok.text == "-" || p.tok.text == "!") {
		t := p.tok
		p.next()
		x, err := p.parseUn()
		if err != nil {
			return nil, err
		}
		op := OpNeg
		if t.text == "!" {
			op = OpNot
		}
		return &Expr{Kind: Unary, Op: op, Span: Span{t.lo, x.Span.Hi}, X: x}, nil
	}
	return p.parsePrimary()
}

func (p *parser) parsePrimary() (*Expr, error) {
	t := p.tok
	switch t.kind {
	case tkNum:
		p.next()
		v, err := strconv.ParseInt(t.text, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("bad number %q at offset %d", t.text, t.lo)
		}
		return &Expr{Kind: Const, Val: int32(v), Span: Span{t.lo, t.hi}}, nil
	case tkIdent:
		p.next()
		return &Expr{Kind: Var, Name: t.text, Span: Span{t.lo, t.hi}}, nil
	case tkOp:
		if t.text == "(" {
			p.next()
			e, err := p.parseCond()
			if err != nil {
				return nil, err
			}
			cl, err := p.expect(")")
			if err != nil {
				return nil, err
			}
			e.Span = Span{t.lo, cl.hi}
			return e, nil
		}
	}
	return nil, fmt.Errorf("unexpected %q at offset %d", strings.TrimSpace(t.text), t.lo)
}
