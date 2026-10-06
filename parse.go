package colcalc

import (
	"fmt"
	"strconv"
)

// ParseExpr compiles a textual expression into an Expr.
//
// Grammar (loosest binding first):
//
//	expr     := orExpr
//	orExpr   := andExpr ("or" andExpr)*
//	andExpr  := cmpExpr ("and" cmpExpr)*
//	cmpExpr  := addExpr (("=="|"!="|"<="|">="|"<"|">") addExpr)?
//	addExpr  := mulExpr (("+"|"-") mulExpr)*
//	mulExpr  := unary (("*"|"/"|"%") unary)*
//	unary    := ("-"|"not") unary | primary
//	primary  := number | string | "true" | "false" | "null"
//	          | "if" "(" expr "," expr "," ")" | "(" expr ")" | ident
//
// Identifiers reference columns; the keywords and/or/not/if/true/false/null
// are reserved and cannot be used as column names.
func ParseExpr(src string) (Expr, error) {
	toks, err := lex(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	e, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	if t := p.peek(); t.kind != tEOF {
		return nil, fmt.Errorf("colcalc: unexpected trailing %q", t.text)
	}
	return e, nil
}

type tokKind int

const (
	tEOF tokKind = iota
	tIdent
	tNumber
	tString
	tOp
)

type token struct {
	kind tokKind
	text string
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }
func isAlpha(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func lex(src string) ([]token, error) {
	var toks []token
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '(' || c == ')' || c == ',' || c == '+' || c == '-' ||
			c == '*' || c == '/' || c == '%':
			toks = append(toks, token{tOp, string(c)})
			i++
		case c == '=' || c == '!' || c == '<' || c == '>':
			if i+1 < len(src) && src[i+1] == '=' {
				toks = append(toks, token{tOp, src[i : i+2]})
				i += 2
			} else if c == '<' || c == '>' {
				toks = append(toks, token{tOp, string(c)})
				i++
			} else {
				return nil, fmt.Errorf("colcalc: unexpected character %q", string(c))
			}
		case c == '"':
			j := i + 1
			for j < len(src) && src[j] != '"' {
				if src[j] == '\\' {
					j++
				}
				j++
			}
			if j >= len(src) {
				return nil, fmt.Errorf("colcalc: unterminated string literal")
			}
			toks = append(toks, token{tString, src[i : j+1]})
			i = j + 1
		case isDigit(c) || c == '.' && i+1 < len(src) && isDigit(src[i+1]):
			j := i
			for j < len(src) && (isDigit(src[j]) || src[j] == '.') {
				j++
			}
			if j < len(src) && (src[j] == 'e' || src[j] == 'E') {
				k := j + 1
				if k < len(src) && (src[k] == '+' || src[k] == '-') {
					k++
				}
				if k < len(src) && isDigit(src[k]) {
					for k < len(src) && isDigit(src[k]) {
						k++
					}
					j = k
				}
			}
			toks = append(toks, token{tNumber, src[i:j]})
			i = j
		case isAlpha(c):
			j := i
			for j < len(src) && (isAlpha(src[j]) || isDigit(src[j])) {
				j++
			}
			toks = append(toks, token{tIdent, src[i:j]})
			i = j
		default:
			return nil, fmt.Errorf("colcalc: unexpected character %q", string(c))
		}
	}
	return append(toks, token{tEOF, ""}), nil
}

type parser struct {
	toks []token
	pos  int
}

func (p *parser) peek() token { return p.toks[p.pos] }
func (p *parser) next() token { t := p.toks[p.pos]; p.pos++; return t }
func (p *parser) atIdent(s string) bool {
	t := p.peek()
	return t.kind == tIdent && t.text == s
}

func (p *parser) expectOp(op string) error {
	if t := p.peek(); t.kind == tOp && t.text == op {
		p.pos++
		return nil
	}
	return fmt.Errorf("colcalc: expected %q, found %q", op, p.peek().text)
}

func (p *parser) parseOr() (Expr, error) {
	l, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for p.atIdent("or") {
		p.next()
		r, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		l = Or(l, r)
	}
	return l, nil
}

func (p *parser) parseAnd() (Expr, error) {
	l, err := p.parseCmp()
	if err != nil {
		return nil, err
	}
	for p.atIdent("and") {
		p.next()
		r, err := p.parseCmp()
		if err != nil {
			return nil, err
		}
		l = And(l, r)
	}
	return l, nil
}

func (p *parser) parseCmp() (Expr, error) {
	l, err := p.parseAdd()
	if err != nil {
		return nil, err
	}
	t := p.peek()
	if t.kind != tOp {
		return l, nil
	}
	var op func(Expr, Expr) Expr
	switch t.text {
	case "==":
		op = Eq
	case "!=":
		op = Ne
	case "<":
		op = Lt
	case "<=":
		op = Le
	case ">":
		op = Gt
	case ">=":
		op = Ge
	default:
		return l, nil
	}
	p.next()
	r, err := p.parseAdd()
	if err != nil {
		return nil, err
	}
	return op(l, r), nil
}

func (p *parser) parseAdd() (Expr, error) {
	l, err := p.parseMul()
	if err != nil {
		return nil, err
	}
	for {
		t := p.peek()
		if t.kind != tOp || t.text != "+" && t.text != "-" {
			return l, nil
		}
		p.next()
		r, err := p.parseMul()
		if err != nil {
			return nil, err
		}
		if t.text == "+" {
			l = Add(l, r)
		} else {
			l = Sub(l, r)
		}
	}
}

func (p *parser) parseMul() (Expr, error) {
	l, err := p.parseUnary()
	if err != nil {
		return nil, err
	}
	for {
		t := p.peek()
		if t.kind != tOp || t.text != "*" && t.text != "/" && t.text != "%" {
			return l, nil
		}
		p.next()
		r, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		switch t.text {
		case "*":
			l = Mul(l, r)
		case "/":
			l = Div(l, r)
		case "%":
			l = Mod(l, r)
		}
	}
}

func (p *parser) parseUnary() (Expr, error) {
	t := p.peek()
	if t.kind == tOp && t.text == "-" {
		p.next()
		e, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return Neg(e), nil
	}
	if t.kind == tIdent && t.text == "not" {
		p.next()
		e, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return Not(e), nil
	}
	return p.parsePrimary()
}

func (p *parser) parsePrimary() (Expr, error) {
	t := p.next()
	switch t.kind {
	case tNumber:
		f, err := strconv.ParseFloat(t.text, 64)
		if err != nil {
			return nil, fmt.Errorf("colcalc: invalid number %q", t.text)
		}
		return Lit(f), nil
	case tString:
		s, err := strconv.Unquote(t.text)
		if err != nil {
			return nil, fmt.Errorf("colcalc: invalid string literal %s", t.text)
		}
		return Lit(s), nil
	case tIdent:
		switch t.text {
		case "true":
			return Lit(true), nil
		case "false":
			return Lit(false), nil
		case "null":
			return Lit(nil), nil
		case "if":
			if err := p.expectOp("("); err != nil {
				return nil, err
			}
			cond, err := p.parseOr()
			if err != nil {
				return nil, err
			}
			if err := p.expectOp(","); err != nil {
				return nil, err
			}
			then, err := p.parseOr()
			if err != nil {
				return nil, err
			}
			if err := p.expectOp(","); err != nil {
				return nil, err
			}
			els, err := p.parseOr()
			if err != nil {
				return nil, err
			}
			if err := p.expectOp(")"); err != nil {
				return nil, err
			}
			return If(cond, then, els), nil
		default:
			return Col(t.text), nil
		}
	case tOp:
		if t.text == "(" {
			e, err := p.parseOr()
			if err != nil {
				return nil, err
			}
			if err := p.expectOp(")"); err != nil {
				return nil, err
			}
			return e, nil
		}
	}
	return nil, fmt.Errorf("colcalc: unexpected %q", t.text)
}
