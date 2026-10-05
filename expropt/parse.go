package expropt

import (
	"fmt"
	"strconv"
)

// Parse parses an integer expression, recording byte offsets in Pos fields.
//
// Grammar (loosest first):
//
//	or   := and ("||" and)*
//	and  := cmp ("&&" cmp)*
//	cmp  := add (("=="|"!"|"<="|">="|"<"|">") add)*
//	add  := mul (("+"|"-") mul)*
//	mul  := atom (("*"|"/") atom)*
//	atom := integer | "(" or ")"
func Parse(src string) (Node, error) {
	p := &parser{src: src}
	n, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	p.skipSpace()
	if p.i != len(p.src) {
		return nil, fmt.Errorf("unexpected trailing input at offset %d", p.i)
	}
	return n, nil
}

type parser struct {
	src string
	i   int
}

func (p *parser) skipSpace() {
	for p.i < len(p.src) && (p.src[p.i] == ' ' || p.src[p.i] == '\t') {
		p.i++
	}
}

func (p *parser) match(s string) (int, bool) {
	p.skipSpace()
	at := p.i
	if len(p.src)-p.i >= len(s) && p.src[p.i:p.i+len(s)] == s {
		p.i += len(s)
		return at, true
	}
	return 0, false
}

func (p *parser) parseOr() (Node, error) {
	l, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for {
		if at, ok := p.match("||"); ok {
			r, err := p.parseAnd()
			if err != nil {
				return nil, err
			}
			l = &Binary{Op: Or, L: l, R: r, At: at}
		} else {
			return l, nil
		}
	}
}

func (p *parser) parseAnd() (Node, error) {
	l, err := p.parseCmp()
	if err != nil {
		return nil, err
	}
	for {
		if at, ok := p.match("&&"); ok {
			r, err := p.parseCmp()
			if err != nil {
				return nil, err
			}
			l = &Binary{Op: And, L: l, R: r, At: at}
		} else {
			return l, nil
		}
	}
}

func (p *parser) parseCmp() (Node, error) {
	l, err := p.parseAdd()
	if err != nil {
		return nil, err
	}
	for _, c := range []struct {
		tok string
		op  Op
	}{{"==", Eq}, {"!=", Ne}, {"<=", Le}, {">=", Ge}, {"<", Lt}, {">", Gt}} {
		if at, ok := p.match(c.tok); ok {
			r, err := p.parseAdd()
			if err != nil {
				return nil, err
			}
			return &Binary{Op: c.op, L: l, R: r, At: at}, nil
		}
	}
	return l, nil
}

func (p *parser) parseAdd() (Node, error) {
	l, err := p.parseMul()
	if err != nil {
		return nil, err
	}
	for {
		if at, ok := p.match("+"); ok {
			r, err := p.parseMul()
			if err != nil {
				return nil, err
			}
			l = &Binary{Op: Add, L: l, R: r, At: at}
		} else if at, ok := p.match("-"); ok {
			r, err := p.parseMul()
			if err != nil {
				return nil, err
			}
			l = &Binary{Op: Sub, L: l, R: r, At: at}
		} else {
			return l, nil
		}
	}
}

func (p *parser) parseMul() (Node, error) {
	l, err := p.parseAtom()
	if err != nil {
		return nil, err
	}
	for {
		if at, ok := p.match("*"); ok {
			r, err := p.parseAtom()
			if err != nil {
				return nil, err
			}
			l = &Binary{Op: Mul, L: l, R: r, At: at}
		} else if at, ok := p.match("/"); ok {
			r, err := p.parseAtom()
			if err != nil {
				return nil, err
			}
			l = &Binary{Op: Div, L: l, R: r, At: at}
		} else {
			return l, nil
		}
	}
}

func (p *parser) parseAtom() (Node, error) {
	p.skipSpace()
	at := p.i
	if p.i < len(p.src) && p.src[p.i] == '(' {
		p.i++
		n, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		if _, ok := p.match(")"); !ok {
			return nil, fmt.Errorf("missing ')' at offset %d", p.i)
		}
		return n, nil
	}
	start := p.i
	for p.i < len(p.src) && p.src[p.i] >= '0' && p.src[p.i] <= '9' {
		p.i++
	}
	if p.i == start {
		return nil, fmt.Errorf("expected integer or '(' at offset %d", at)
	}
	v, err := strconv.ParseInt(p.src[start:p.i], 10, 64)
	if err != nil {
		return nil, err
	}
	return &Const{Val: v, At: at}, nil
}
