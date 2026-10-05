package interp

import (
	"fmt"
	"strings"
)

type tokKind int

const (
	tokEOF tokKind = iota
	tokNewline
	tokNum
	tokIdent
	tokOp
)

type token struct {
	kind tokKind
	text string
	val  int64
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
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '#':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '\n':
			toks = append(toks, token{kind: tokNewline, text: "\n"})
			i++
		case isDigit(c):
			j := i
			var v int64
			for j < len(src) && isDigit(src[j]) {
				v = v*10 + int64(src[j]-'0')
				j++
			}
			toks = append(toks, token{kind: tokNum, text: src[i:j], val: v})
			i = j
		case isAlpha(c):
			j := i
			for j < len(src) && (isAlpha(src[j]) || isDigit(src[j])) {
				j++
			}
			toks = append(toks, token{kind: tokIdent, text: src[i:j]})
			i = j
		default:
			var op string
			if i+1 < len(src) {
				two := src[i : i+2]
				if two == "==" || two == "!=" || two == "<=" || two == ">=" {
					op = two
				}
			}
			if op == "" && strings.IndexByte("+-*/%<>=():!", c) >= 0 {
				op = src[i : i+1]
			}
			if op == "" {
				return nil, fmt.Errorf("unexpected character %q", string(c))
			}
			toks = append(toks, token{kind: tokOp, text: op})
			i += len(op)
		}
	}
	toks = append(toks, token{kind: tokEOF})
	return toks, nil
}

type parser struct {
	toks []token
	pos  int
}

func (p *parser) peek() token  { return p.toks[p.pos] }
func (p *parser) peek2() token { return p.toks[p.pos+1] }
func (p *parser) next() token  { t := p.toks[p.pos]; p.pos++; return t }

func (p *parser) expectOp(op string) error {
	if t := p.peek(); t.kind == tokOp && t.text == op {
		p.next()
		return nil
	}
	return fmt.Errorf("expected %q, got %q", op, p.peek().text)
}

func (p *parser) expectIdent() (string, error) {
	if t := p.peek(); t.kind == tokIdent {
		p.next()
		return t.text, nil
	}
	return "", fmt.Errorf("expected identifier, got %q", p.peek().text)
}

// ParseExpr parses a single pure expression from src.
func ParseExpr(src string) (Expr, error) {
	toks, err := lex(src)
	if err != nil {
		return nil, err
	}
	filtered := toks[:0]
	for _, t := range toks {
		if t.kind != tokNewline {
			filtered = append(filtered, t)
		}
	}
	p := &parser{toks: filtered}
	e, err := p.parseExpr()
	if err != nil {
		return nil, err
	}
	if t := p.peek(); t.kind != tokEOF {
		return nil, fmt.Errorf("unexpected trailing input %q", t.text)
	}
	return e, nil
}

// Parse parses a whole program.
//
// Grammar (one statement per line, '#' starts a comment):
//
//	line    := [ident ":"] stmt
//	stmt    := "let" ident "=" expr
//	         | ident "=" expr
//	         | "print" expr
//	         | "if" expr "goto" ident
//	         | "goto" ident
//	         | "end"
func Parse(src string) (*Program, error) {
	toks, err := lex(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	prog := &Program{Labels: map[string]int{}}
	for {
		for p.peek().kind == tokNewline {
			p.next()
		}
		if p.peek().kind == tokEOF {
			break
		}
		if p.peek().kind == tokIdent && p.peek2().kind == tokOp && p.peek2().text == ":" {
			label := p.next().text
			p.next() // ':'
			if _, dup := prog.Labels[label]; dup {
				return nil, fmt.Errorf("duplicate label %q", label)
			}
			prog.Labels[label] = len(prog.Stmts)
			continue
		}
		stmt, err := p.parseStmt()
		if err != nil {
			return nil, err
		}
		prog.Stmts = append(prog.Stmts, stmt)
		if t := p.peek(); t.kind != tokNewline && t.kind != tokEOF {
			return nil, fmt.Errorf("expected end of line, got %q", t.text)
		}
	}
	return prog, nil
}

func (p *parser) parseStmt() (Stmt, error) {
	t := p.peek()
	if t.kind != tokIdent {
		return nil, fmt.Errorf("expected statement, got %q", t.text)
	}
	switch t.text {
	case "let":
		p.next()
		name, err := p.expectIdent()
		if err != nil {
			return nil, err
		}
		if err := p.expectOp("="); err != nil {
			return nil, err
		}
		e, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		return Assign{Name: name, Expr: e}, nil
	case "print":
		p.next()
		e, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		return Print{Expr: e}, nil
	case "goto":
		p.next()
		label, err := p.expectIdent()
		if err != nil {
			return nil, err
		}
		return Goto{Label: label}, nil
	case "if":
		p.next()
		cond, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		kw, err := p.expectIdent()
		if err != nil {
			return nil, err
		}
		if kw != "goto" {
			return nil, fmt.Errorf("expected \"goto\" after if condition, got %q", kw)
		}
		label, err := p.expectIdent()
		if err != nil {
			return nil, err
		}
		return IfGoto{Cond: cond, Label: label}, nil
	case "end":
		p.next()
		return End{}, nil
	default:
		p.next()
		if err := p.expectOp("="); err != nil {
			return nil, err
		}
		e, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		return Assign{Name: t.text, Expr: e}, nil
	}
}

func (p *parser) parseExpr() (Expr, error) {
	left, err := p.parseAdd()
	if err != nil {
		return nil, err
	}
	t := p.peek()
	if t.kind == tokOp {
		switch t.text {
		case "<", "<=", ">", ">=", "==", "!=":
			p.next()
			right, err := p.parseAdd()
			if err != nil {
				return nil, err
			}
			return Binary{Op: t.text, L: left, R: right}, nil
		}
	}
	return left, nil
}

func (p *parser) parseAdd() (Expr, error) {
	left, err := p.parseMul()
	if err != nil {
		return nil, err
	}
	for {
		t := p.peek()
		if t.kind == tokOp && (t.text == "+" || t.text == "-") {
			p.next()
			right, err := p.parseMul()
			if err != nil {
				return nil, err
			}
			left = Binary{Op: t.text, L: left, R: right}
			continue
		}
		return left, nil
	}
}

func (p *parser) parseMul() (Expr, error) {
	left, err := p.parseUnary()
	if err != nil {
		return nil, err
	}
	for {
		t := p.peek()
		if t.kind == tokOp && (t.text == "*" || t.text == "/" || t.text == "%") {
			p.next()
			right, err := p.parseUnary()
			if err != nil {
				return nil, err
			}
			left = Binary{Op: t.text, L: left, R: right}
			continue
		}
		return left, nil
	}
}

func (p *parser) parseUnary() (Expr, error) {
	t := p.peek()
	if t.kind == tokOp && (t.text == "-" || t.text == "!") {
		p.next()
		x, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		return Unary{Op: t.text, X: x}, nil
	}
	return p.parsePrimary()
}

func (p *parser) parsePrimary() (Expr, error) {
	t := p.next()
	switch t.kind {
	case tokNum:
		return NumLit{Val: t.val}, nil
	case tokIdent:
		return Var{Name: t.text}, nil
	case tokOp:
		if t.text == "(" {
			e, err := p.parseExpr()
			if err != nil {
				return nil, err
			}
			if err := p.expectOp(")"); err != nil {
				return nil, err
			}
			return e, nil
		}
	}
	return nil, fmt.Errorf("unexpected token %q", t.text)
}
