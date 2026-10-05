package interp

import (
	"fmt"
	"strconv"
	"strings"
)

// NodeKind is the kind of an AST node.
type NodeKind int

const (
	NNil NodeKind = iota
	NInt
	NStr
	NBool
	NSym
	NList
)

// Node is a single concrete AST type so machine states stay (gob-)serializable.
type Node struct {
	Kind NodeKind
	I    int64
	S    string
	B    bool
	Kids []*Node
}

func isSym(n *Node, s string) bool { return n != nil && n.Kind == NSym && n.S == s }

// --- tokenizer ---

const (
	tLParen = iota
	tRParen
	tQuote
	tAtom
	tString
)

type token struct {
	typ  int
	text string
}

func tokenize(src string) ([]token, error) {
	var toks []token
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == ';':
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '(':
			toks = append(toks, token{tLParen, "("})
			i++
		case c == ')':
			toks = append(toks, token{tRParen, ")"})
			i++
		case c == '\'':
			toks = append(toks, token{tQuote, "'"})
			i++
		case c == '"':
			i++
			var sb strings.Builder
			for {
				if i >= len(src) {
					return nil, fmt.Errorf("unterminated string literal")
				}
				if src[i] == '"' {
					i++
					break
				}
				if src[i] == '\\' {
					i++
					if i >= len(src) {
						return nil, fmt.Errorf("unterminated escape")
					}
					switch src[i] {
					case 'n':
						sb.WriteByte('\n')
					case 't':
						sb.WriteByte('\t')
					case '"':
						sb.WriteByte('"')
					case '\\':
						sb.WriteByte('\\')
					default:
						return nil, fmt.Errorf("bad escape \\%c", src[i])
					}
					i++
					continue
				}
				sb.WriteByte(src[i])
				i++
			}
			toks = append(toks, token{tString, sb.String()})
		default:
			j := i
			for j < len(src) && !strings.ContainsRune("()';\" \t\n\r", rune(src[j])) {
				j++
			}
			toks = append(toks, token{tAtom, src[i:j]})
			i = j
		}
	}
	return toks, nil
}

type parser struct {
	toks []token
	pos  int
}

func (p *parser) parseExpr() (*Node, error) {
	if p.pos >= len(p.toks) {
		return nil, fmt.Errorf("unexpected end of input")
	}
	t := p.toks[p.pos]
	p.pos++
	switch t.typ {
	case tLParen:
		var kids []*Node
		for {
			if p.pos >= len(p.toks) {
				return nil, fmt.Errorf("unexpected end of input in list")
			}
			if p.toks[p.pos].typ == tRParen {
				p.pos++
				break
			}
			k, err := p.parseExpr()
			if err != nil {
				return nil, err
			}
			kids = append(kids, k)
		}
		if len(kids) == 0 {
			return &Node{Kind: NNil}, nil
		}
		return &Node{Kind: NList, Kids: kids}, nil
	case tRParen:
		return nil, fmt.Errorf("unexpected )")
	case tQuote:
		n, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		return &Node{Kind: NList, Kids: []*Node{{Kind: NSym, S: "quote"}, n}}, nil
	case tString:
		return &Node{Kind: NStr, S: t.text}, nil
	default: // tAtom
		if v, err := strconv.ParseInt(t.text, 10, 64); err == nil {
			return &Node{Kind: NInt, I: v}, nil
		}
		switch t.text {
		case "true":
			return &Node{Kind: NBool, B: true}, nil
		case "false":
			return &Node{Kind: NBool, B: false}, nil
		case "nil":
			return &Node{Kind: NNil}, nil
		}
		return &Node{Kind: NSym, S: t.text}, nil
	}
}

// Parse parses a program: a sequence of top-level forms.
func Parse(src string) ([]*Node, error) {
	toks, err := tokenize(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	var forms []*Node
	for p.pos < len(p.toks) {
		n, err := p.parseExpr()
		if err != nil {
			return nil, err
		}
		forms = append(forms, n)
	}
	return forms, nil
}

// --- special form helpers shared by both interpreters ---

type tryForm struct {
	Body        []*Node
	HasCatch    bool
	CatchParam  string
	CatchBody   []*Node
	HasFinally  bool
	FinallyBody []*Node
}

func parseTry(n *Node) (*tryForm, error) {
	t := &tryForm{}
	for _, k := range n.Kids[1:] {
		if k.Kind == NList && len(k.Kids) > 0 && isSym(k.Kids[0], "catch") {
			if t.HasCatch {
				return nil, fmt.Errorf("try: duplicate catch")
			}
			if len(k.Kids) < 2 || k.Kids[1].Kind != NList || len(k.Kids[1].Kids) != 1 ||
				k.Kids[1].Kids[0].Kind != NSym {
				return nil, fmt.Errorf("try: malformed catch clause")
			}
			t.HasCatch = true
			t.CatchParam = k.Kids[1].Kids[0].S
			t.CatchBody = k.Kids[2:]
			continue
		}
		if k.Kind == NList && len(k.Kids) > 0 && isSym(k.Kids[0], "finally") {
			if t.HasFinally {
				return nil, fmt.Errorf("try: duplicate finally")
			}
			t.HasFinally = true
			t.FinallyBody = k.Kids[1:]
			continue
		}
		if t.HasCatch || t.HasFinally {
			return nil, fmt.Errorf("try: body expression after catch/finally clause")
		}
		t.Body = append(t.Body, k)
	}
	if !t.HasCatch && !t.HasFinally {
		return nil, fmt.Errorf("try: need at least one catch or finally clause")
	}
	return t, nil
}

func parseBindings(n *Node) ([]string, []*Node, error) {
	if n.Kind == NNil {
		return nil, nil, nil
	}
	if n.Kind != NList {
		return nil, nil, fmt.Errorf("let: malformed bindings")
	}
	var names []string
	var exprs []*Node
	for _, b := range n.Kids {
		if b.Kind != NList || len(b.Kids) != 2 || b.Kids[0].Kind != NSym {
			return nil, nil, fmt.Errorf("let: malformed binding")
		}
		names = append(names, b.Kids[0].S)
		exprs = append(exprs, b.Kids[1])
	}
	return names, exprs, nil
}

func paramNames(n *Node) ([]string, error) {
	if n.Kind == NNil {
		return nil, nil
	}
	if n.Kind != NList {
		return nil, fmt.Errorf("lambda: malformed parameter list")
	}
	var ps []string
	for _, p := range n.Kids {
		if p.Kind != NSym {
			return nil, fmt.Errorf("lambda: parameter must be a symbol")
		}
		ps = append(ps, p.S)
	}
	return ps, nil
}

// astToValue converts a quoted AST into a runtime value.
func astToValue(n *Node) Value {
	switch n.Kind {
	case NInt:
		return n.I
	case NStr:
		return n.S
	case NBool:
		return n.B
	case NNil:
		return nil
	case NSym:
		return Symbol(n.S)
	case NList:
		var v Value
		for i := len(n.Kids) - 1; i >= 0; i-- {
			v = &Pair{Car: astToValue(n.Kids[i]), Cdr: v}
		}
		return v
	}
	return nil
}
