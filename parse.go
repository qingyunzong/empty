package foldexpr

import (
	"fmt"
	"strconv"
)

type token struct {
	kind string // "num", "ident", "op", "eof"
	s    string
	pos  int
}

func lex(src string) ([]token, error) {
	var toks []token
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case isDigit(c):
			j := i
			for j < len(src) && isDigit(src[j]) {
				j++
			}
			toks = append(toks, token{"num", src[i:j], i})
			i = j
		case c == '_' || isLetter(c):
			j := i
			for j < len(src) && (src[j] == '_' || isLetter(src[j]) || isDigit(src[j])) {
				j++
			}
			toks = append(toks, token{"ident", src[i:j], i})
			i = j
		default:
			if i+1 < len(src) {
				switch src[i : i+2] {
				case "&&", "||", "==", "!=", "<=", ">=":
					toks = append(toks, token{"op", src[i : i+2], i})
					i += 2
					continue
				}
			}
			switch c {
			case '+', '-', '*', '/', '%', '(', ')', '<', '>', '!', '?', ':':
				toks = append(toks, token{"op", string(c), i})
				i++
			default:
				return nil, fmt.Errorf("unexpected character %q at offset %d", c, i)
			}
		}
	}
	toks = append(toks, token{"eof", "", len(src)})
	return toks, nil
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
func isLetter(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

// Parse parses src into an AST. Numeric literals are interpreted as
// decimal and wrapped modulo 2^32 into int32.
func Parse(src string) (Node, error) {
	toks, err := lex(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	n, err := p.parseCond()
	if err != nil {
		return nil, err
	}
	if t := p.peek(); t.kind != "eof" {
		return nil, fmt.Errorf("unexpected token %q at offset %d", t.s, t.pos)
	}
	return n, nil
}

type parser struct {
	toks []token
	i    int
}

func (p *parser) peek() token { return p.toks[p.i] }
func (p *parser) next() token { t := p.toks[p.i]; p.i++; return t }
func (p *parser) at(op string) bool {
	t := p.peek()
	return t.kind == "op" && t.s == op
}

func (p *parser) expect(op string) (token, error) {
	if !p.at(op) {
		t := p.peek()
		return t, fmt.Errorf("expected %q, found %q at offset %d", op, t.s, t.pos)
	}
	return p.next(), nil
}

func (p *parser) parseCond() (Node, error) {
	c, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	if p.at("?") {
		q := p.next()
		then, err := p.parseCond()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(":"); err != nil {
			return nil, err
		}
		els, err := p.parseCond()
		if err != nil {
			return nil, err
		}
		return &Cond{P: q.pos, C: c, T: then, F: els}, nil
	}
	return c, nil
}

func (p *parser) parseOr() (Node, error) {
	return p.parseLeftAssoc(p.parseAnd, "||")
}

func (p *parser) parseAnd() (Node, error) {
	return p.parseLeftAssoc(p.parseCmp, "&&")
}

func (p *parser) parseCmp() (Node, error) {
	return p.parseLeftAssoc(p.parseAdd, "==", "!=", "<", "<=", ">", ">=")
}

func (p *parser) parseAdd() (Node, error) {
	return p.parseLeftAssoc(p.parseMul, "+", "-")
}

func (p *parser) parseMul() (Node, error) {
	return p.parseLeftAssoc(p.parseUnary, "*", "/", "%")
}

func (p *parser) parseLeftAssoc(next func() (Node, error), ops ...string) (Node, error) {
	l, err := next()
	if err != nil {
		return nil, err
	}
	for {
		matched := ""
		for _, op := range ops {
			if p.at(op) {
				matched = op
				break
			}
		}
		if matched == "" {
			return l, nil
		}
		t := p.next()
		r, err := next()
		if err != nil {
			return nil, err
		}
		l = &Binary{P: t.pos, Op: matched, L: l, R: r}
	}
}

func (p *parser) parseUnary() (Node, error) {
	if p.at("-") || p.at("!") {
		t := p.next()
		x, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return &Unary{P: t.pos, Op: t.s, X: x}, nil
	}
	return p.parsePrimary()
}

func (p *parser) parsePrimary() (Node, error) {
	t := p.peek()
	switch t.kind {
	case "num":
		p.next()
		v, err := strconv.ParseInt(t.s, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("number %q out of range at offset %d", t.s, t.pos)
		}
		return &Const{P: t.pos, Val: int32(v)}, nil
	case "ident":
		p.next()
		return &Var{P: t.pos, Name: t.s}, nil
	case "op":
		if t.s == "(" {
			p.next()
			n, err := p.parseCond()
			if err != nil {
				return nil, err
			}
			if _, err := p.expect(")"); err != nil {
				return nil, err
			}
			return n, nil
		}
	}
	return nil, fmt.Errorf("unexpected token %q at offset %d", t.s, t.pos)
}
