package linearchk

import (
	"fmt"
	"strings"
)

// Parse reads a program from source text, one command per line:
//
//	new x
//	share r = &x
//	excl m = &mut x
//	use x
//	mut m
//	move y = x
//	drop r
//	if { ... } else { ... }
//
// '#' starts a comment; braces may appear anywhere tokens may.
func Parse(src string) ([]Cmd, error) {
	p := &parser{}
	for lineNo, line := range strings.Split(src, "\n") {
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		for _, f := range strings.Fields(line) {
			for _, w := range splitBraces(f) {
				p.toks = append(p.toks, token{word: w, line: fmt.Sprint(lineNo + 1)})
			}
		}
	}
	cmds, err := p.cmds()
	if err != nil {
		return nil, err
	}
	if p.pos != len(p.toks) {
		return nil, p.errf("unexpected %q", p.peek())
	}
	return cmds, nil
}

func splitBraces(f string) []string {
	var out []string
	for f != "" {
		i := strings.IndexAny(f, "{}")
		if i < 0 {
			out = append(out, f)
			break
		}
		if i > 0 {
			out = append(out, f[:i])
		}
		out = append(out, f[i:i+1])
		f = f[i+1:]
	}
	return out
}

type token struct {
	word string
	line string
}

type parser struct {
	toks []token
	pos  int
}

func (p *parser) peek() string {
	if p.pos >= len(p.toks) {
		return "<eof>"
	}
	return p.toks[p.pos].word
}

func (p *parser) next() string {
	t := p.peek()
	if p.pos < len(p.toks) {
		p.pos++
	}
	return t
}

func (p *parser) errf(format string, args ...any) error {
	line := "?"
	if p.pos < len(p.toks) {
		line = p.toks[p.pos].line
	} else if len(p.toks) > 0 {
		line = p.toks[len(p.toks)-1].line
	}
	return fmt.Errorf("line %s: %s", line, fmt.Sprintf(format, args...))
}

func (p *parser) expect(w string) error {
	if p.peek() != w {
		return p.errf("expected %q, got %q", w, p.peek())
	}
	p.pos++
	return nil
}

func (p *parser) name() (string, error) {
	w := p.next()
	if w == "" || strings.ContainsAny(w, "{}=&") || w == "<eof>" {
		return "", p.errf("expected a name, got %q", w)
	}
	return w, nil
}

func (p *parser) cmds() ([]Cmd, error) {
	var out []Cmd
	for p.pos < len(p.toks) && p.peek() != "}" {
		c, err := p.cmd()
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}

func (p *parser) block() ([]Cmd, error) {
	if err := p.expect("{"); err != nil {
		return nil, err
	}
	cmds, err := p.cmds()
	if err != nil {
		return nil, err
	}
	if err := p.expect("}"); err != nil {
		return nil, err
	}
	return cmds, nil
}

func (p *parser) cmd() (Cmd, error) {
	switch kw := p.next(); kw {
	case "new":
		n, err := p.name()
		return New{Name: n}, err
	case "use":
		n, err := p.name()
		return Use{Name: n}, err
	case "mut":
		n, err := p.name()
		return Mut{Name: n}, err
	case "drop":
		n, err := p.name()
		return Drop{Name: n}, err
	case "share", "excl":
		b, err := p.name()
		if err != nil {
			return nil, err
		}
		if err := p.expect("="); err != nil {
			return nil, err
		}
		o, err := p.operand(kw == "excl")
		if err != nil {
			return nil, err
		}
		if kw == "share" {
			return Share{Borrow: b, Owner: o}, nil
		}
		return Excl{Borrow: b, Owner: o}, nil
	case "move":
		d, err := p.name()
		if err != nil {
			return nil, err
		}
		if err := p.expect("="); err != nil {
			return nil, err
		}
		s, err := p.name()
		return Move{Dst: d, Src: s}, err
	case "if":
		then, err := p.block()
		if err != nil {
			return nil, err
		}
		if err := p.expect("else"); err != nil {
			return nil, err
		}
		els, err := p.block()
		if err != nil {
			return nil, err
		}
		return If{Then: then, Else: els}, nil
	default:
		return nil, p.errf("unknown command %q", kw)
	}
}

// operand parses "&x", "& x", "&mut x" or "&mutx".
func (p *parser) operand(mut bool) (string, error) {
	ref := p.next()
	want := "&"
	if mut {
		want = "&mut"
	}
	if !strings.HasPrefix(ref, want) || (!mut && strings.HasPrefix(ref, "&mut")) {
		return "", p.errf("expected %q, got %q", want, ref)
	}
	if rest := ref[len(want):]; rest != "" {
		return rest, nil
	}
	return p.name()
}
