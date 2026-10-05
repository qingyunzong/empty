package interp

import (
	"fmt"
	"strconv"
	"strings"
)

// Parse compiles a single s-expression program into a *Node.
//
// Grammar (special forms):
//
//	(if c a b) (begin e...) (lambda [name] (params) body...)
//	(let ((x e)...) body...) (letrec ((f (lambda ...)...) body...)
//	(try body... (catch (e) h...) (finally f...))
//	(throw e) (f args...)  literals: ints, "strings", true, false, nil
func Parse(src string) (*Node, error) {
	toks, err := tokenize(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	n, err := p.expr()
	if err != nil {
		return nil, err
	}
	if p.pos != len(p.toks) {
		return nil, fmt.Errorf("parse: trailing tokens after expression")
	}
	return n, nil
}

type token struct {
	text string
	str  bool // string literal
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
		case c == '(' || c == ')':
			toks = append(toks, token{text: string(c)})
			i++
		case c == '"':
			var sb strings.Builder
			i++
			for i < len(src) && src[i] != '"' {
				if src[i] == '\\' && i+1 < len(src) {
					i++
					switch src[i] {
					case 'n':
						sb.WriteByte('\n')
					case 't':
						sb.WriteByte('\t')
					default:
						sb.WriteByte(src[i])
					}
					i++
					continue
				}
				sb.WriteByte(src[i])
				i++
			}
			if i >= len(src) {
				return nil, fmt.Errorf("parse: unterminated string")
			}
			i++
			toks = append(toks, token{text: sb.String(), str: true})
		default:
			j := i
			for j < len(src) && !strings.ContainsRune("() \t\n\r;", rune(src[j])) {
				j++
			}
			toks = append(toks, token{text: src[i:j]})
			i = j
		}
	}
	return toks, nil
}

type parser struct {
	toks []token
	pos  int
}

func (p *parser) peek() string {
	if p.pos < len(p.toks) {
		return p.toks[p.pos].text
	}
	return ""
}

func (p *parser) expr() (*Node, error) {
	if p.pos >= len(p.toks) {
		return nil, fmt.Errorf("parse: unexpected end of input")
	}
	t := p.toks[p.pos]
	p.pos++
	if t.str {
		return &Node{Kind: KStr, Str: t.text}, nil
	}
	switch t.text {
	case "(":
		return p.list()
	case ")":
		return nil, fmt.Errorf("parse: unexpected )")
	case "true":
		return &Node{Kind: KBool, Num: 1}, nil
	case "false":
		return &Node{Kind: KBool}, nil
	case "nil":
		return &Node{Kind: KNil}, nil
	}
	if n, err := strconv.ParseInt(t.text, 10, 64); err == nil {
		return &Node{Kind: KInt, Num: n}, nil
	}
	return &Node{Kind: KSym, Sym: t.text}, nil
}

func (p *parser) list() (*Node, error) {
	if p.pos < len(p.toks) && !p.toks[p.pos].str && isSpecial(p.toks[p.pos].text) {
		head := p.toks[p.pos].text
		p.pos++
		n, err := p.special(head)
		if err != nil {
			return nil, err
		}
		if err := p.close(); err != nil {
			return nil, err
		}
		return n, nil
	}
	fn, err := p.expr()
	if err != nil {
		return nil, err
	}
	var args []*Node
	for p.peek() != ")" && p.peek() != "" {
		a, err := p.expr()
		if err != nil {
			return nil, err
		}
		args = append(args, a)
	}
	if err := p.close(); err != nil {
		return nil, err
	}
	return &Node{Kind: KCall, Func: fn, Args: args}, nil
}

func (p *parser) close() error {
	if p.peek() != ")" {
		return fmt.Errorf("parse: expected ), got %q", p.peek())
	}
	p.pos++
	return nil
}

func isSpecial(s string) bool {
	switch s {
	case "if", "begin", "lambda", "let", "letrec", "try", "throw":
		return true
	}
	return false
}

func (p *parser) special(head string) (*Node, error) {
	switch head {
	case "if":
		c, err := p.expr()
		if err != nil {
			return nil, err
		}
		a, err := p.expr()
		if err != nil {
			return nil, err
		}
		b, err := p.expr()
		if err != nil {
			return nil, err
		}
		return &Node{Kind: KIf, Cond: c, Then: a, Else: b}, nil
	case "begin":
		var body []*Node
		for p.peek() != ")" && p.peek() != "" {
			e, err := p.expr()
			if err != nil {
				return nil, err
			}
			body = append(body, e)
		}
		return &Node{Kind: KBegin, Body: body}, nil
	case "lambda":
		return p.lambda("")
	case "let":
		return p.let(false)
	case "letrec":
		return p.let(true)
	case "throw":
		e, err := p.expr()
		if err != nil {
			return nil, err
		}
		return &Node{Kind: KThrow, Sub: e}, nil
	case "try":
		return p.try()
	}
	return nil, fmt.Errorf("parse: unknown special form %q", head)
}

func (p *parser) lambda(selfName string) (*Node, error) {
	name := selfName
	if name == "" && p.pos < len(p.toks) && !p.toks[p.pos].str &&
		p.toks[p.pos].text != "(" && p.toks[p.pos].text != ")" {
		name = p.toks[p.pos].text
		p.pos++
	}
	if p.peek() != "(" {
		return nil, fmt.Errorf("parse: lambda expects parameter list")
	}
	p.pos++
	var params []string
	for p.peek() != ")" && p.peek() != "" {
		params = append(params, p.toks[p.pos].text)
		p.pos++
	}
	if err := p.close(); err != nil {
		return nil, err
	}
	var body []*Node
	for p.peek() != ")" && p.peek() != "" {
		e, err := p.expr()
		if err != nil {
			return nil, err
		}
		body = append(body, e)
	}
	if len(body) == 0 {
		return nil, fmt.Errorf("parse: lambda needs a body")
	}
	return &Node{Kind: KLambda, Name: name, Params: params, Body: body}, nil
}

// let desugars to an immediately applied lambda; letrec additionally gives
// each bound lambda its own name so it can recurse.
func (p *parser) let(rec bool) (*Node, error) {
	if p.peek() != "(" {
		return nil, fmt.Errorf("parse: let expects binding list")
	}
	p.pos++
	var names []string
	var vals []*Node
	for p.peek() != ")" && p.peek() != "" {
		if p.peek() != "(" {
			return nil, fmt.Errorf("parse: malformed binding")
		}
		p.pos++
		name := p.toks[p.pos].text
		p.pos++
		var v *Node
		var err error
		if rec {
			if p.peek() != "(" {
				return nil, fmt.Errorf("parse: letrec values must be lambdas")
			}
			p.pos++
			if p.peek() != "lambda" {
				return nil, fmt.Errorf("parse: letrec values must be lambdas")
			}
			p.pos++
			v, err = p.lambda(name)
			if err != nil {
				return nil, err
			}
			if err := p.close(); err != nil { // close lambda form
				return nil, err
			}
		} else {
			v, err = p.expr()
			if err != nil {
				return nil, err
			}
		}
		if err := p.close(); err != nil { // close binding pair
			return nil, err
		}
		names = append(names, name)
		vals = append(vals, v)
	}
	if err := p.close(); err != nil { // close binding list
		return nil, err
	}
	var body []*Node
	for p.peek() != ")" && p.peek() != "" {
		e, err := p.expr()
		if err != nil {
			return nil, err
		}
		body = append(body, e)
	}
	if len(body) == 0 {
		return nil, fmt.Errorf("parse: let needs a body")
	}
	fn := &Node{Kind: KLambda, Params: names, Body: body}
	return &Node{Kind: KCall, Func: fn, Args: vals}, nil
}

func (p *parser) try() (*Node, error) {
	n := &Node{Kind: KTry}
	for p.peek() != ")" && p.peek() != "" {
		if p.peek() == "(" && p.pos+1 < len(p.toks) && !p.toks[p.pos+1].str {
			switch p.toks[p.pos+1].text {
			case "catch":
				p.pos += 2
				if p.peek() != "(" {
					return nil, fmt.Errorf("parse: catch expects (param)")
				}
				p.pos++
				n.CatchParam = p.toks[p.pos].text
				p.pos++
				if err := p.close(); err != nil {
					return nil, err
				}
				for p.peek() != ")" && p.peek() != "" {
					e, err := p.expr()
					if err != nil {
						return nil, err
					}
					n.Catch = append(n.Catch, e)
				}
				if err := p.close(); err != nil {
					return nil, err
				}
				n.HasCatch = true
				continue
			case "finally":
				p.pos += 2
				for p.peek() != ")" && p.peek() != "" {
					e, err := p.expr()
					if err != nil {
						return nil, err
					}
					n.Final = append(n.Final, e)
				}
				if err := p.close(); err != nil {
					return nil, err
				}
				n.HasFinal = true
				continue
			}
		}
		e, err := p.expr()
		if err != nil {
			return nil, err
		}
		n.Body = append(n.Body, e)
	}
	if !n.HasCatch && !n.HasFinal {
		return nil, fmt.Errorf("parse: try needs catch or finally")
	}
	return n, nil
}
