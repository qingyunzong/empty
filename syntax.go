package searchre

import (
	"fmt"
	"strings"
)

type nodeKind int

const (
	kEmpty nodeKind = iota
	kChar
	kConcat
	kAlt
	kStar
	kQuest
	kGroup
)

type node struct {
	kind nodeKind
	id   int     // unique id per node, used by the brute-force loop guard
	ch   rune    // kChar
	kids []*node // kConcat, kAlt
	sub  *node   // kStar, kQuest, kGroup
	gid  int     // kGroup: capture index, 1-based
}

type parser struct {
	src     []rune
	pos     int
	nextID  int
	ngroups int
}

func (p *parser) newNode(kind nodeKind) *node {
	n := &node{kind: kind, id: p.nextID}
	p.nextID++
	return n
}

// parse parses pattern into an AST and the number of capture groups.
//
// Grammar:
//
//	alt    := concat ('|' concat)*
//	concat := repeat*
//	repeat := atom ('*' | '?')*
//	atom   := '(' alt ')' | literal
func parse(pattern string) (*node, int, error) {
	p := &parser{src: []rune(pattern)}
	n, err := p.parseAlt()
	if err != nil {
		return nil, 0, err
	}
	if p.pos < len(p.src) {
		return nil, 0, fmt.Errorf("unexpected %q at offset %d", string(p.src[p.pos]), p.pos)
	}
	return n, p.ngroups, nil
}

func (p *parser) peek() (rune, bool) {
	if p.pos >= len(p.src) {
		return 0, false
	}
	return p.src[p.pos], true
}

func (p *parser) parseAlt() (*node, error) {
	first, err := p.parseConcat()
	if err != nil {
		return nil, err
	}
	branches := []*node{first}
	for {
		if c, ok := p.peek(); !ok || c != '|' {
			break
		}
		p.pos++
		b, err := p.parseConcat()
		if err != nil {
			return nil, err
		}
		branches = append(branches, b)
	}
	if len(branches) == 1 {
		return first, nil
	}
	n := p.newNode(kAlt)
	n.kids = branches
	return n, nil
}

func (p *parser) parseConcat() (*node, error) {
	var kids []*node
	for {
		c, ok := p.peek()
		if !ok || c == '|' || c == ')' {
			break
		}
		n, err := p.parseRepeat()
		if err != nil {
			return nil, err
		}
		kids = append(kids, n)
	}
	switch len(kids) {
	case 0:
		return p.newNode(kEmpty), nil
	case 1:
		return kids[0], nil
	default:
		n := p.newNode(kConcat)
		n.kids = kids
		return n, nil
	}
}

func (p *parser) parseRepeat() (*node, error) {
	n, err := p.parseAtom()
	if err != nil {
		return nil, err
	}
	for {
		c, ok := p.peek()
		if !ok || (c != '*' && c != '?') {
			return n, nil
		}
		p.pos++
		wrap := p.newNode(kStar)
		if c == '?' {
			wrap.kind = kQuest
		}
		wrap.sub = n
		n = wrap
	}
}

func (p *parser) parseAtom() (*node, error) {
	c, ok := p.peek()
	if !ok {
		return nil, fmt.Errorf("unexpected end of pattern")
	}
	switch c {
	case '(':
		p.pos++
		p.ngroups++
		gid := p.ngroups
		sub, err := p.parseAlt()
		if err != nil {
			return nil, err
		}
		if c, ok := p.peek(); !ok || c != ')' {
			return nil, fmt.Errorf("missing closing )")
		}
		p.pos++
		n := p.newNode(kGroup)
		n.sub = sub
		n.gid = gid
		return n, nil
	case ')':
		return nil, fmt.Errorf("unmatched ) at offset %d", p.pos)
	case '*', '?':
		return nil, fmt.Errorf("dangling %q at offset %d", string(c), p.pos)
	case '|':
		return nil, fmt.Errorf("unexpected | at offset %d", p.pos)
	case '\\':
		p.pos++
		c, ok := p.peek()
		if !ok {
			return nil, fmt.Errorf("trailing backslash")
		}
		p.pos++
		n := p.newNode(kChar)
		n.ch = c
		return n, nil
	default:
		p.pos++
		n := p.newNode(kChar)
		n.ch = c
		return n, nil
	}
}

// render regenerates a pattern string from the AST (used in tests).
func render(n *node) string {
	var sb strings.Builder
	renderInto(&sb, n, 0)
	return sb.String()
}

// prec: 0 = top/alt, 1 = concat, 2 = repeat/atom
func renderInto(sb *strings.Builder, n *node, prec int) {
	switch n.kind {
	case kEmpty:
	case kChar:
		if strings.ContainsRune(`()|*?\`, n.ch) {
			sb.WriteByte('\\')
		}
		sb.WriteRune(n.ch)
	case kConcat:
		if prec > 1 {
			sb.WriteByte('(')
		}
		for _, k := range n.kids {
			renderInto(sb, k, 1)
		}
		if prec > 1 {
			sb.WriteByte(')')
		}
	case kAlt:
		if prec > 0 {
			sb.WriteByte('(')
		}
		for i, k := range n.kids {
			if i > 0 {
				sb.WriteByte('|')
			}
			renderInto(sb, k, 0)
		}
		if prec > 0 {
			sb.WriteByte(')')
		}
	case kStar:
		renderRepeatSub(sb, n.sub)
		sb.WriteByte('*')
	case kQuest:
		renderRepeatSub(sb, n.sub)
		sb.WriteByte('?')
	case kGroup:
		sb.WriteByte('(')
		renderInto(sb, n.sub, 0)
		sb.WriteByte(')')
	}
}

// renderRepeatSub renders a quantifier operand; an empty operand is
// rendered as "()" so the quantifier is never left dangling.
func renderRepeatSub(sb *strings.Builder, n *node) {
	if n.kind == kEmpty {
		sb.WriteString("()")
		return
	}
	renderInto(sb, n, 2)
}
