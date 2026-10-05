// Package licenseselect selects license branches for reachable packages in a
// dependency graph so that compatibility constraints are satisfied with the
// fewest exceptions.
package licenseselect

import (
	"fmt"
	"sort"
	"strings"
)

// Expr is a license expression AST.
type Expr interface{ isExpr() }

// License is a single named license, e.g. "MIT".
type License struct{ Name string }

// And requires both sides.
type And struct{ L, R Expr }

// Or allows choosing either side.
type Or struct{ L, R Expr }

func (License) isExpr() {}
func (And) isExpr()     {}
func (Or) isExpr()      {}

type token struct {
	kind string // "name", "and", "or", "lparen", "rparen"
	text string
}

func tokenize(s string) ([]token, error) {
	var toks []token
	i := 0
	for i < len(s) {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c == '(':
			toks = append(toks, token{kind: "lparen"})
			i++
		case c == ')':
			toks = append(toks, token{kind: "rparen"})
			i++
		case c == '+' || c == '-' || c == '.' || c == '/' || c == ':' ||
			(c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'):
			j := i
			for j < len(s) {
				d := s[j]
				if d == '+' || d == '-' || d == '.' || d == '/' || d == ':' ||
					(d >= '0' && d <= '9') || (d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z') {
					j++
				} else {
					break
				}
			}
			word := s[i:j]
			switch strings.ToUpper(word) {
			case "AND":
				toks = append(toks, token{kind: "and"})
			case "OR":
				toks = append(toks, token{kind: "or"})
			default:
				toks = append(toks, token{kind: "name", text: word})
			}
			i = j
		default:
			return nil, fmt.Errorf("unexpected character %q at offset %d", c, i)
		}
	}
	return toks, nil
}

// ParseExpr parses a license expression with AND, OR and parentheses.
// AND binds tighter than OR.
func ParseExpr(s string) (Expr, error) {
	toks, err := tokenize(s)
	if err != nil {
		return nil, err
	}
	p := &parser{toks: toks}
	e, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	if p.pos != len(p.toks) {
		return nil, fmt.Errorf("unexpected trailing token at offset %d", p.pos)
	}
	return e, nil
}

type parser struct {
	toks []token
	pos  int
}

func (p *parser) peek() (token, bool) {
	if p.pos < len(p.toks) {
		return p.toks[p.pos], true
	}
	return token{}, false
}

func (p *parser) parseOr() (Expr, error) {
	l, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for {
		if t, ok := p.peek(); ok && t.kind == "or" {
			p.pos++
			r, err := p.parseAnd()
			if err != nil {
				return nil, err
			}
			l = Or{L: l, R: r}
		} else {
			return l, nil
		}
	}
}

func (p *parser) parseAnd() (Expr, error) {
	l, err := p.parseAtom()
	if err != nil {
		return nil, err
	}
	for {
		if t, ok := p.peek(); ok && t.kind == "and" {
			p.pos++
			r, err := p.parseAtom()
			if err != nil {
				return nil, err
			}
			l = And{L: l, R: r}
		} else {
			return l, nil
		}
	}
}

func (p *parser) parseAtom() (Expr, error) {
	t, ok := p.peek()
	if !ok {
		return nil, fmt.Errorf("unexpected end of expression")
	}
	switch t.kind {
	case "name":
		p.pos++
		return License{Name: t.text}, nil
	case "lparen":
		p.pos++
		e, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		if nt, ok := p.peek(); !ok || nt.kind != "rparen" {
			return nil, fmt.Errorf("missing closing parenthesis")
		}
		p.pos++
		return e, nil
	default:
		return nil, fmt.Errorf("unexpected token %q", t.text)
	}
}

// Branch is one selectable licensing alternative: the set of license names
// that must all be complied with when this branch is chosen.
type Branch []string

// Branches expands an expression into its disjunctive normal form: the list
// of alternative branches. AND merges sets, OR concatenates alternatives.
// Duplicate branches are removed and each branch is sorted.
func Branches(e Expr) []Branch {
	var out []Branch
	switch n := e.(type) {
	case License:
		out = []Branch{{n.Name}}
	case And:
		ls, rs := Branches(n.L), Branches(n.R)
		for _, l := range ls {
			for _, r := range rs {
				merged := mergeBranch(l, r)
				out = append(out, merged)
			}
		}
	case Or:
		out = append(Branches(n.L), Branches(n.R)...)
	}
	return dedupBranches(out)
}

func mergeBranch(a, b Branch) Branch {
	set := map[string]bool{}
	for _, x := range a {
		set[x] = true
	}
	for _, x := range b {
		set[x] = true
	}
	out := make(Branch, 0, len(set))
	for x := range set {
		out = append(out, x)
	}
	sort.Strings(out)
	return out
}

func dedupBranches(in []Branch) []Branch {
	seen := map[string]bool{}
	var out []Branch
	for _, b := range in {
		key := strings.Join(b, "\x00")
		if !seen[key] {
			seen[key] = true
			out = append(out, b)
		}
	}
	return out
}
