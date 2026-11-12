package dataeng

import (
	"fmt"
	"strconv"
)

// CmpOp identifies a comparison operator.
type CmpOp int

const (
	// CmpEq is the equality operator "=".
	CmpEq CmpOp = iota
	// CmpLt is the strict less-than operator "<".
	CmpLt
	// CmpLe is the less-than-or-equal operator "<=".
	CmpLe
)

func (op CmpOp) String() string {
	switch op {
	case CmpEq:
		return "="
	case CmpLt:
		return "<"
	case CmpLe:
		return "<="
	default:
		return "?"
	}
}

// Node is a parsed but not yet type-checked expression. The concrete types
// are *BoolExpr and *ValueExpr.
type Node interface{ astNode() }

// BoolExpr is a parsed boolean expression node.
type BoolExpr struct {
	Op    string // "and", "or", "not", "cmp", "isnull"
	Left  Node
	Right Node
	Cmp   CmpOp
}

// ValueExpr is a parsed value operand: a column reference, a typed literal,
// or the untyped null literal.
type ValueExpr struct {
	IsColumn bool
	Column   string
	Type     ColumnType // 0 for the untyped null literal
	IntVal   int64
	StrVal   string
	IsNull   bool
}

func (*BoolExpr) astNode()  {}
func (*ValueExpr) astNode() {}

type parser struct {
	tokens []token
	pos    int
}

// Parse parses source into an untyped expression tree. Type checking against
// a schema happens separately in Compile.
func Parse(source string) (Node, error) {
	tokens, err := lex(source)
	if err != nil {
		return nil, err
	}
	p := &parser{tokens: tokens}
	node, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	if p.peek().kind != tokEOF {
		return nil, p.syntaxError(p.peek(), "unexpected token %q", p.peek().text)
	}
	return node, nil
}

func (p *parser) parseOr() (Node, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for p.peek().kind == tokOr {
		p.next()
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		left = &BoolExpr{Op: "or", Left: left, Right: right}
	}
	return left, nil
}

func (p *parser) parseAnd() (Node, error) {
	left, err := p.parseNot()
	if err != nil {
		return nil, err
	}
	for p.peek().kind == tokAnd {
		p.next()
		right, err := p.parseNot()
		if err != nil {
			return nil, err
		}
		left = &BoolExpr{Op: "and", Left: left, Right: right}
	}
	return left, nil
}

func (p *parser) parseNot() (Node, error) {
	if p.peek().kind == tokNot {
		p.next()
		inner, err := p.parseNot()
		if err != nil {
			return nil, err
		}
		return &BoolExpr{Op: "not", Left: inner}, nil
	}
	return p.parsePrimary()
}

func (p *parser) parsePrimary() (Node, error) {
	tok := p.peek()
	switch tok.kind {
	case tokLParen:
		p.next()
		inner, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		if p.peek().kind != tokRParen {
			return nil, p.syntaxError(p.peek(), "expected closing parenthesis")
		}
		p.next()
		return inner, nil
	case tokInt, tokString, tokNull, tokIdent:
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		switch p.peek().kind {
		case tokIs:
			p.next()
			if p.peek().kind != tokNull {
				return nil, p.syntaxError(p.peek(), `expected NULL after IS`)
			}
			p.next()
			return &BoolExpr{Op: "isnull", Left: value}, nil
		case tokEq, tokLt, tokLe:
			opTok := p.next()
			right, err := p.parseValue()
			if err != nil {
				return nil, err
			}
			op := CmpEq
			switch opTok.kind {
			case tokLt:
				op = CmpLt
			case tokLe:
				op = CmpLe
			}
			return &BoolExpr{Op: "cmp", Left: value, Right: right, Cmp: op}, nil
		default:
			// A bare value is syntactically valid here; the type checker
			// rejects it when a boolean expression is required.
			return value, nil
		}
	default:
		return nil, p.syntaxError(tok, "unexpected token %q", tok.text)
	}
}

func (p *parser) parseValue() (*ValueExpr, error) {
	tok := p.next()
	switch tok.kind {
	case tokIdent:
		return &ValueExpr{IsColumn: true, Column: tok.text}, nil
	case tokInt:
		n, err := strconv.ParseInt(tok.text, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("%w: integer literal %q at position %d: %v",
				ErrSyntax, tok.text, tok.pos, err)
		}
		return &ValueExpr{Type: TypeInt64, IntVal: n}, nil
	case tokString:
		return &ValueExpr{Type: TypeString, StrVal: tok.text}, nil
	case tokNull:
		return &ValueExpr{IsNull: true}, nil
	default:
		return nil, p.syntaxError(tok, "expected column reference or literal")
	}
}

func (p *parser) peek() token {
	return p.tokens[p.pos]
}

func (p *parser) next() token {
	tok := p.tokens[p.pos]
	if p.pos < len(p.tokens)-1 {
		p.pos++
	}
	return tok
}

func (p *parser) syntaxError(tok token, format string, args ...any) error {
	msg := fmt.Sprintf(format, args...)
	return fmt.Errorf("%w: at position %d: %s", ErrSyntax, tok.pos, msg)
}
