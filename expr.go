package debuglib

import (
	"fmt"
	"strconv"
)

// Expr is a pure expression: evaluation only reads the environment and can
// never modify program state. This is what makes breakpoint conditions pure
// by construction.
type Expr interface {
	Eval(env map[string]int64) (int64, error)
}

type Const struct{ V int64 }

func (c Const) Eval(map[string]int64) (int64, error) { return c.V, nil }

type Var struct{ Name string }

func (v Var) Eval(env map[string]int64) (int64, error) {
	val, ok := env[v.Name]
	if !ok {
		return 0, fmt.Errorf("undefined variable %q", v.Name)
	}
	return val, nil
}

type Neg struct{ E Expr }

func (n Neg) Eval(env map[string]int64) (int64, error) {
	v, err := n.E.Eval(env)
	return -v, err
}

type Bin struct {
	Op   string
	L, R Expr
}

func (b Bin) Eval(env map[string]int64) (int64, error) {
	l, err := b.L.Eval(env)
	if err != nil {
		return 0, err
	}
	r, err := b.R.Eval(env)
	if err != nil {
		return 0, err
	}
	switch b.Op {
	case "+":
		return l + r, nil
	case "-":
		return l - r, nil
	case "*":
		return l * r, nil
	case "/":
		if r == 0 {
			return 0, fmt.Errorf("division by zero")
		}
		return l / r, nil
	case "%":
		if r == 0 {
			return 0, fmt.Errorf("modulo by zero")
		}
		return l % r, nil
	case "==":
		return boolInt(l == r), nil
	case "!=":
		return boolInt(l != r), nil
	case "<":
		return boolInt(l < r), nil
	case "<=":
		return boolInt(l <= r), nil
	case ">":
		return boolInt(l > r), nil
	case ">=":
		return boolInt(l >= r), nil
	}
	return 0, fmt.Errorf("unknown operator %q", b.Op)
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// ParseExpr parses a pure expression from source text.
//
// Grammar:
//
//	cmp     := add (("=="|"!="|"<="|">="|"<"|">") add)*
//	add     := mul (("+"|"-") mul)*
//	mul     := unary (("*"|"/"|"%") unary)*
//	unary   := "-" unary | primary
//	primary := number | ident | "(" cmp ")"
func ParseExpr(src string) (Expr, error) {
	p := &parser{src: src}
	e, err := p.parseCmp()
	if err != nil {
		return nil, err
	}
	p.skipWS()
	if p.pos != len(p.src) {
		return nil, fmt.Errorf("unexpected trailing input %q", src[p.pos:])
	}
	return e, nil
}

type parser struct {
	src string
	pos int
}

func (p *parser) skipWS() {
	for p.pos < len(p.src) && (p.src[p.pos] == ' ' || p.src[p.pos] == '\t') {
		p.pos++
	}
}

func (p *parser) match(ops ...string) (string, bool) {
	p.skipWS()
	for _, op := range ops {
		if len(p.src)-p.pos >= len(op) && p.src[p.pos:p.pos+len(op)] == op {
			p.pos += len(op)
			return op, true
		}
	}
	return "", false
}

func (p *parser) parseCmp() (Expr, error) {
	l, err := p.parseAdd()
	if err != nil {
		return nil, err
	}
	for {
		if op, ok := p.match("==", "!=", "<=", ">=", "<", ">"); ok {
			r, err := p.parseAdd()
			if err != nil {
				return nil, err
			}
			l = Bin{Op: op, L: l, R: r}
		} else {
			return l, nil
		}
	}
}

func (p *parser) parseAdd() (Expr, error) {
	l, err := p.parseMul()
	if err != nil {
		return nil, err
	}
	for {
		if op, ok := p.match("+", "-"); ok {
			r, err := p.parseMul()
			if err != nil {
				return nil, err
			}
			l = Bin{Op: op, L: l, R: r}
		} else {
			return l, nil
		}
	}
}

func (p *parser) parseMul() (Expr, error) {
	l, err := p.parseUnary()
	if err != nil {
		return nil, err
	}
	for {
		if op, ok := p.match("*", "/", "%"); ok {
			r, err := p.parseUnary()
			if err != nil {
				return nil, err
			}
			l = Bin{Op: op, L: l, R: r}
		} else {
			return l, nil
		}
	}
}

func (p *parser) parseUnary() (Expr, error) {
	if _, ok := p.match("-"); ok {
		e, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return Neg{E: e}, nil
	}
	return p.parsePrimary()
}

func (p *parser) parsePrimary() (Expr, error) {
	p.skipWS()
	if p.pos >= len(p.src) {
		return nil, fmt.Errorf("unexpected end of expression")
	}
	c := p.src[p.pos]
	switch {
	case c == '(':
		p.pos++
		e, err := p.parseCmp()
		if err != nil {
			return nil, err
		}
		if _, ok := p.match(")"); !ok {
			return nil, fmt.Errorf("missing closing parenthesis")
		}
		return e, nil
	case c >= '0' && c <= '9':
		start := p.pos
		for p.pos < len(p.src) && p.src[p.pos] >= '0' && p.src[p.pos] <= '9' {
			p.pos++
		}
		n, err := strconv.ParseInt(p.src[start:p.pos], 10, 64)
		if err != nil {
			return nil, err
		}
		return Const{V: n}, nil
	case c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'):
		start := p.pos
		for p.pos < len(p.src) {
			ch := p.src[p.pos]
			if ch == '_' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') {
				p.pos++
			} else {
				break
			}
		}
		return Var{Name: p.src[start:p.pos]}, nil
	}
	return nil, fmt.Errorf("unexpected character %q", string(c))
}
