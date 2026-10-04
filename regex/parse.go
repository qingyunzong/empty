package regex

import "fmt"

type nodeKind int

const (
	kLit nodeKind = iota
	kConcat
	kAlt
	kStar
	kQuest
	kGroup
)

type node struct {
	kind     nodeKind
	c        byte
	children []*node
	groupIdx int
}

type parser struct {
	src    string
	pos    int
	groups int
}

// parse parses pattern and returns the root node and the total number of
// capture groups including group 0 (the whole match).
func parse(pattern string) (*node, int, error) {
	p := &parser{src: pattern, groups: 1}
	n, err := p.parseAlt()
	if err != nil {
		return nil, 0, err
	}
	if p.pos != len(p.src) {
		return nil, 0, fmt.Errorf("unexpected %q at offset %d", rune(p.src[p.pos]), p.pos)
	}
	return n, p.groups, nil
}

func (p *parser) parseAlt() (*node, error) {
	var branches []*node
	for {
		b, err := p.parseConcat()
		if err != nil {
			return nil, err
		}
		branches = append(branches, b)
		if p.pos < len(p.src) && p.src[p.pos] == '|' {
			p.pos++
			continue
		}
		break
	}
	if len(branches) == 1 {
		return branches[0], nil
	}
	return &node{kind: kAlt, children: branches}, nil
}

func (p *parser) parseConcat() (*node, error) {
	var parts []*node
	for p.pos < len(p.src) && p.src[p.pos] != '|' && p.src[p.pos] != ')' {
		a, err := p.parseRepeat()
		if err != nil {
			return nil, err
		}
		parts = append(parts, a)
	}
	if len(parts) == 1 {
		return parts[0], nil
	}
	return &node{kind: kConcat, children: parts}, nil
}

func (p *parser) parseRepeat() (*node, error) {
	a, err := p.parseAtom()
	if err != nil {
		return nil, err
	}
	for p.pos < len(p.src) {
		switch p.src[p.pos] {
		case '*':
			a = &node{kind: kStar, children: []*node{a}}
			p.pos++
		case '?':
			a = &node{kind: kQuest, children: []*node{a}}
			p.pos++
		default:
			return a, nil
		}
	}
	return a, nil
}

func (p *parser) parseAtom() (*node, error) {
	if p.pos >= len(p.src) {
		return nil, fmt.Errorf("unexpected end of pattern")
	}
	c := p.src[p.pos]
	switch c {
	case '(':
		p.pos++
		idx := p.groups
		p.groups++
		body, err := p.parseAlt()
		if err != nil {
			return nil, err
		}
		if p.pos >= len(p.src) || p.src[p.pos] != ')' {
			return nil, fmt.Errorf("missing closing )")
		}
		p.pos++
		return &node{kind: kGroup, groupIdx: idx, children: []*node{body}}, nil
	case ')':
		return nil, fmt.Errorf("unexpected )")
	case '*', '?', '|':
		return nil, fmt.Errorf("unexpected %q", rune(c))
	case '\\':
		p.pos++
		if p.pos >= len(p.src) {
			return nil, fmt.Errorf("trailing backslash")
		}
		c = p.src[p.pos]
		p.pos++
		return &node{kind: kLit, c: c}, nil
	default:
		p.pos++
		return &node{kind: kLit, c: c}, nil
	}
}
