// Package licchk computes reachable packages from a dependency-graph entry
// point, parses license expressions with AND/OR operators, and selects one
// license branch per package (for at most MaxPackages packages) so that all
// compatibility constraints hold with a minimal number of exceptions.
package licchk

import (
	"fmt"
	"sort"
	"strings"
)

// Expr is a license expression AST. The concrete types are *Leaf, *And and
// *Or.
type Expr interface {
	exprNode()
	String() string
}

// Leaf is a single license identifier such as "MIT".
type Leaf struct{ Name string }

// And requires both sub-expressions.
type And struct{ L, R Expr }

// Or offers a choice between the two sub-expressions.
type Or struct{ L, R Expr }

func (*Leaf) exprNode() {}
func (*And) exprNode()  {}
func (*Or) exprNode()   {}

func (l *Leaf) String() string { return l.Name }
func (a *And) String() string  { return "(" + a.L.String() + " AND " + a.R.String() + ")" }
func (o *Or) String() string   { return "(" + o.L.String() + " OR " + o.R.String() + ")" }

// Option is one concrete license set obtainable from an expression by
// resolving every OR choice. Names are sorted and deduplicated.
type Option []string

// Options enumerates every distinct license set an expression can yield.
func Options(e Expr) []Option {
	switch n := e.(type) {
	case *Leaf:
		return []Option{{n.Name}}
	case *And:
		var out []Option
		for _, l := range Options(n.L) {
			for _, r := range Options(n.R) {
				out = append(out, mergeOption(l, r))
			}
		}
		return dedupOptions(out)
	case *Or:
		return dedupOptions(append(Options(n.L), Options(n.R)...))
	}
	panic(fmt.Sprintf("licchk: unknown expression node %T", e))
}

func mergeOption(a, b Option) Option {
	set := make(map[string]struct{}, len(a)+len(b))
	for _, s := range a {
		set[s] = struct{}{}
	}
	for _, s := range b {
		set[s] = struct{}{}
	}
	out := make(Option, 0, len(set))
	for s := range set {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

func dedupOptions(in []Option) []Option {
	seen := make(map[string]struct{}, len(in))
	out := in[:0]
	for _, o := range in {
		key := strings.Join(o, "\x00")
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, o)
	}
	return out
}

// ParseExpr parses a license expression such as
// "MIT OR (Apache-2.0 AND BSD-3-Clause)". AND binds tighter than OR.
// Keywords are case-insensitive; identifiers may contain letters, digits,
// '.', '-', '_', '+' and ':'.
func ParseExpr(src string) (Expr, error) {
	p := &exprParser{lx: &lexer{src: src}}
	if err := p.advance(); err != nil {
		return nil, err
	}
	e, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	if p.tok.kind != tokEOF {
		return nil, fmt.Errorf("licchk: unexpected trailing input %q at offset %d", p.tok.text, p.tok.off)
	}
	return e, nil
}

type tokKind int

const (
	tokEOF tokKind = iota
	tokIdent
	tokAnd
	tokOr
	tokLParen
	tokRParen
)

type token struct {
	kind tokKind
	text string
	off  int
}

type lexer struct {
	src string
	pos int
}

func isIdentByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	switch c {
	case '.', '-', '_', '+', ':':
		return true
	}
	return false
}

func (lx *lexer) next() (token, error) {
	for lx.pos < len(lx.src) {
		switch lx.src[lx.pos] {
		case ' ', '\t', '\n', '\r':
			lx.pos++
		default:
			goto scan
		}
	}
	return token{kind: tokEOF, off: lx.pos}, nil
scan:
	start := lx.pos
	c := lx.src[lx.pos]
	switch c {
	case '(':
		lx.pos++
		return token{kind: tokLParen, text: "(", off: start}, nil
	case ')':
		lx.pos++
		return token{kind: tokRParen, text: ")", off: start}, nil
	}
	if !isIdentByte(c) {
		return token{}, fmt.Errorf("licchk: invalid character %q at offset %d", c, start)
	}
	for lx.pos < len(lx.src) && isIdentByte(lx.src[lx.pos]) {
		lx.pos++
	}
	word := lx.src[start:lx.pos]
	switch strings.ToUpper(word) {
	case "AND":
		return token{kind: tokAnd, text: word, off: start}, nil
	case "OR":
		return token{kind: tokOr, text: word, off: start}, nil
	}
	return token{kind: tokIdent, text: word, off: start}, nil
}

type exprParser struct {
	lx  *lexer
	tok token
}

func (p *exprParser) advance() error {
	t, err := p.lx.next()
	if err != nil {
		return err
	}
	p.tok = t
	return nil
}

func (p *exprParser) parseOr() (Expr, error) {
	l, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for p.tok.kind == tokOr {
		if err := p.advance(); err != nil {
			return nil, err
		}
		r, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		l = &Or{L: l, R: r}
	}
	return l, nil
}

func (p *exprParser) parseAnd() (Expr, error) {
	l, err := p.parseAtom()
	if err != nil {
		return nil, err
	}
	for p.tok.kind == tokAnd {
		if err := p.advance(); err != nil {
			return nil, err
		}
		r, err := p.parseAtom()
		if err != nil {
			return nil, err
		}
		l = &And{L: l, R: r}
	}
	return l, nil
}

func (p *exprParser) parseAtom() (Expr, error) {
	switch p.tok.kind {
	case tokIdent:
		name := p.tok.text
		if err := p.advance(); err != nil {
			return nil, err
		}
		return &Leaf{Name: name}, nil
	case tokLParen:
		if err := p.advance(); err != nil {
			return nil, err
		}
		e, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		if p.tok.kind != tokRParen {
			return nil, fmt.Errorf("licchk: expected ')' at offset %d", p.tok.off)
		}
		if err := p.advance(); err != nil {
			return nil, err
		}
		return e, nil
	case tokEOF:
		return nil, fmt.Errorf("licchk: unexpected end of expression")
	default:
		return nil, fmt.Errorf("licchk: unexpected token %q at offset %d", p.tok.text, p.tok.off)
	}
}
