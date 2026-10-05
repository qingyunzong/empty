package main

import (
	"fmt"
	"strings"
)

// Grammar (newline or ";" separates declarations and members):
//
//	program  := (decl | check)*
//	decl     := "type" IDENT "=" typeExpr
//	check    := "check" IDENT "<:" IDENT
//	typeExpr := "interface" "{" member* "}"
//	          | "func" "(" [param {"," param}] ")" [":"] typeExpr
//	          | IDENT                       (named type, primitive, or any)
//	member   := IDENT ":" typeExpr                      (field)
//	          | IDENT "(" [param {"," param}] ")" [":"] typeExpr   (method)
//	param    := [IDENT ":"] typeExpr

type tokKind int

const (
	tEOF tokKind = iota
	tIdent
	tLBrace
	tRBrace
	tLParen
	tRParen
	tColon
	tComma
	tSemi
	tEq
	tSub // "<:"
)

type token struct {
	kind tokKind
	val  string
	line int
}

var primitives = map[string]bool{
	"int": true, "int64": true, "string": true,
	"bool": true, "float64": true, "byte": true, "rune": true,
}

var reserved = map[string]bool{
	"type": true, "interface": true, "func": true, "check": true, "any": true,
}

func lex(src string) ([]token, error) {
	var toks []token
	line := 1
	i := 0
	for i < len(src) {
		c := src[i]
		switch {
		case c == '\n':
			toks = append(toks, token{tSemi, ";", line})
			line++
			i++
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '#' || (c == '/' && i+1 < len(src) && src[i+1] == '/'):
			for i < len(src) && src[i] != '\n' {
				i++
			}
		case c == '{':
			toks = append(toks, token{tLBrace, "{", line})
			i++
		case c == '}':
			toks = append(toks, token{tRBrace, "}", line})
			i++
		case c == '(':
			toks = append(toks, token{tLParen, "(", line})
			i++
		case c == ')':
			toks = append(toks, token{tRParen, ")", line})
			i++
		case c == ':':
			toks = append(toks, token{tColon, ":", line})
			i++
		case c == ',':
			toks = append(toks, token{tComma, ",", line})
			i++
		case c == ';':
			toks = append(toks, token{tSemi, ";", line})
			i++
		case c == '=':
			toks = append(toks, token{tEq, "=", line})
			i++
		case c == '<' && i+1 < len(src) && src[i+1] == ':':
			toks = append(toks, token{tSub, "<:", line})
			i += 2
		case c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z':
			j := i
			for j < len(src) {
				d := src[j]
				if d == '_' || d >= 'a' && d <= 'z' || d >= 'A' && d <= 'Z' || d >= '0' && d <= '9' {
					j++
				} else {
					break
				}
			}
			toks = append(toks, token{tIdent, src[i:j], line})
			i = j
		default:
			return nil, fmt.Errorf("line %d: unexpected character %q", line, string(c))
		}
	}
	toks = append(toks, token{tEOF, "", line})
	return toks, nil
}

// Query is a single "check A <: B" statement.
type Query struct {
	Sub string
	Sup string
}

// Program is a parsed input file: named type declarations plus queries.
type Program struct {
	Types  map[string]*Type
	Order  []string
	Checks []Query
}

type parser struct {
	toks []token
	pos  int
	prog *Program
}

// Parse parses the input and resolves all named references into a shared
// type graph. It validates that no declaration is a bare cyclic alias.
func Parse(src string) (*Program, error) {
	toks, err := lex(src)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks, prog: &Program{Types: map[string]*Type{}}}
	// Pre-register declaration names so recursive and forward references
	// resolve to shared graph nodes.
	for i := 0; i+2 < len(toks); i++ {
		if toks[i].kind == tIdent && toks[i].val == "type" &&
			toks[i+1].kind == tIdent && toks[i+2].kind == tEq {
			name := toks[i+1].val
			if reserved[name] {
				return nil, fmt.Errorf("line %d: cannot declare reserved name %q", toks[i+1].line, name)
			}
			if _, dup := p.prog.Types[name]; dup {
				return nil, fmt.Errorf("line %d: duplicate type declaration %q", toks[i+1].line, name)
			}
			p.prog.Types[name] = &Type{TypeName: name}
			p.prog.Order = append(p.prog.Order, name)
		}
	}
	for {
		p.skipSemi()
		if p.peek().kind == tEOF {
			break
		}
		tok := p.peek()
		if tok.kind != tIdent {
			return nil, fmt.Errorf("line %d: expected \"type\" or \"check\", got %q", tok.line, tok.val)
		}
		switch tok.val {
		case "type":
			if err := p.parseDecl(); err != nil {
				return nil, err
			}
		case "check":
			if err := p.parseCheck(); err != nil {
				return nil, err
			}
		default:
			return nil, fmt.Errorf("line %d: expected \"type\" or \"check\", got %q", tok.line, tok.val)
		}
	}
	if err := p.prog.validate(); err != nil {
		return nil, err
	}
	return p.prog, nil
}

func (p *parser) peek() token { return p.toks[p.pos] }
func (p *parser) next() token { t := p.toks[p.pos]; p.pos++; return t }
func (p *parser) skipSemi() {
	for p.peek().kind == tSemi {
		p.pos++
	}
}

func (p *parser) expect(k tokKind, what string) (token, error) {
	tok := p.next()
	if tok.kind != k {
		return tok, fmt.Errorf("line %d: expected %s, got %q", tok.line, what, tok.val)
	}
	return tok, nil
}

func (p *parser) parseDecl() error {
	p.next() // "type"
	name, err := p.expect(tIdent, "type name")
	if err != nil {
		return err
	}
	if _, err := p.expect(tEq, "\"=\""); err != nil {
		return err
	}
	body, err := p.parseType()
	if err != nil {
		return err
	}
	node := p.prog.Types[name.val]
	*node = *body
	node.TypeName = name.val
	return nil
}

func (p *parser) parseCheck() error {
	p.next() // "check"
	sub, err := p.expect(tIdent, "subtype name")
	if err != nil {
		return err
	}
	if _, err := p.expect(tSub, "\"<:\""); err != nil {
		return err
	}
	sup, err := p.expect(tIdent, "supertype name")
	if err != nil {
		return err
	}
	p.prog.Checks = append(p.prog.Checks, Query{Sub: sub.val, Sup: sup.val})
	return nil
}

func (p *parser) parseType() (*Type, error) {
	tok := p.next()
	if tok.kind != tIdent {
		return nil, fmt.Errorf("line %d: expected a type, got %q", tok.line, tok.val)
	}
	switch tok.val {
	case "interface":
		return p.parseInterface()
	case "func":
		return p.parseFunc()
	case "any":
		return &Type{Kind: KindAny}, nil
	}
	if node, ok := p.prog.Types[tok.val]; ok {
		return node, nil
	}
	if primitives[tok.val] {
		return &Type{Kind: KindPrim, Name: tok.val}, nil
	}
	return nil, fmt.Errorf("line %d: undefined type %q", tok.line, tok.val)
}

func (p *parser) parseInterface() (*Type, error) {
	if _, err := p.expect(tLBrace, "\"{\""); err != nil {
		return nil, err
	}
	iface := &Type{Kind: KindInterface}
	seen := map[string]bool{}
	p.skipSemi()
	for p.peek().kind != tRBrace {
		nameTok, err := p.expect(tIdent, "member name")
		if err != nil {
			return nil, err
		}
		if seen[nameTok.val] {
			return nil, fmt.Errorf("line %d: duplicate member %q", nameTok.line, nameTok.val)
		}
		seen[nameTok.val] = true
		var mtype *Type
		if p.peek().kind == tLParen {
			fn, err := p.parseFunc()
			if err != nil {
				return nil, err
			}
			mtype = fn
		} else {
			if _, err := p.expect(tColon, "\":\" or \"(\" after member name"); err != nil {
				return nil, err
			}
			t, err := p.parseType()
			if err != nil {
				return nil, err
			}
			mtype = t
		}
		iface.Members = append(iface.Members, Member{Name: nameTok.val, Type: mtype})
		if p.peek().kind != tRBrace {
			if _, err := p.expect(tSemi, "newline, \";\" or \"}\" after member"); err != nil {
				return nil, err
			}
			p.skipSemi()
		}
	}
	p.next() // "}"
	return iface, nil
}

// parseFunc parses "( params ) [:] resultType" after the "func" keyword
// (or after a method name) has been consumed.
func (p *parser) parseFunc() (*Type, error) {
	if _, err := p.expect(tLParen, "\"(\""); err != nil {
		return nil, err
	}
	fn := &Type{Kind: KindFunc}
	p.skipSemi()
	if p.peek().kind != tRParen {
		for {
			// Optional parameter name: IDENT ":" type.
			if p.peek().kind == tIdent && p.toks[p.pos+1].kind == tColon {
				p.pos += 2
			}
			pt, err := p.parseType()
			if err != nil {
				return nil, err
			}
			fn.Params = append(fn.Params, pt)
			if p.peek().kind != tComma {
				break
			}
			p.next()
		}
	}
	if _, err := p.expect(tRParen, "\")\""); err != nil {
		return nil, err
	}
	if p.peek().kind == tColon {
		p.next()
	}
	res, err := p.parseType()
	if err != nil {
		return nil, err
	}
	fn.Result = res
	return fn, nil
}

// validate walks the type graph and rejects declarations whose body never
// resolved to a concrete kind (bare cyclic aliases such as "type A = A").
func (prog *Program) validate() error {
	seen := map[*Type]bool{}
	var walk func(t *Type) error
	walk = func(t *Type) error {
		if seen[t] {
			return nil
		}
		seen[t] = true
		if t.Kind == kindUnset {
			return fmt.Errorf("type %s is a cyclic alias with no concrete definition", t.TypeName)
		}
		for _, pt := range t.Params {
			if err := walk(pt); err != nil {
				return err
			}
		}
		if t.Result != nil {
			if err := walk(t.Result); err != nil {
				return err
			}
		}
		for _, m := range t.Members {
			if err := walk(m.Type); err != nil {
				return err
			}
		}
		return nil
	}
	for _, name := range prog.Order {
		if err := walk(prog.Types[name]); err != nil {
			return err
		}
	}
	for _, c := range prog.Checks {
		if _, ok := prog.Types[c.Sub]; !ok {
			return fmt.Errorf("check: undefined type %q", c.Sub)
		}
		if _, ok := prog.Types[c.Sup]; !ok {
			return fmt.Errorf("check: undefined type %q", c.Sup)
		}
	}
	return nil
}

// PathString renders a member path such as ".Read(arg 0)(result)".
func PathString(path []string) string {
	if len(path) == 0 {
		return "<root>"
	}
	return strings.Join(path, "")
}
