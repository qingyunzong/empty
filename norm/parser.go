package norm

import (
	"fmt"
	"io"
	"strconv"
	"strings"
)

const maxDepth = 1000

// parser is a recursive-descent parser for the JSON-with-comments subset.
// It streams normalized output into an io.Writer as it parses; only object
// members are buffered (for sorting), subject to the memory budget.
type parser struct {
	src  []byte
	pos  int
	n    *norm
	path []string
}

func (p *parser) errf(pos int, format string, args ...any) *Error {
	return &Error{Msg: fmt.Sprintf(format, args...), Start: pos, src: p.src}
}

// skipWS consumes JSON whitespace and //... and /*...*/ comments.
func (p *parser) skipWS() error {
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			p.pos++
			continue
		}
		if c == '/' && p.pos+1 < len(p.src) {
			switch p.src[p.pos+1] {
			case '/':
				p.pos += 2
				for p.pos < len(p.src) && p.src[p.pos] != '\n' {
					p.pos++
				}
				continue
			case '*':
				start := p.pos
				p.pos += 2
				closed := false
				for p.pos+1 < len(p.src) {
					if p.src[p.pos] == '*' && p.src[p.pos+1] == '/' {
						p.pos += 2
						closed = true
						break
					}
					p.pos++
				}
				if !closed {
					return &Error{Msg: "unterminated block comment", Start: start, End: len(p.src), src: p.src}
				}
				continue
			}
		}
		return nil
	}
	return nil
}

func (p *parser) value(w io.Writer, depth int) error {
	if depth > maxDepth {
		return p.errf(p.pos, "maximum nesting depth %d exceeded", maxDepth)
	}
	if err := p.skipWS(); err != nil {
		return err
	}
	if p.pos >= len(p.src) {
		return p.errf(p.pos, "unexpected end of input, expected a value")
	}
	start := p.pos
	c := p.src[p.pos]
	switch {
	case c == '{':
		p.pos++
		if err := p.object(w, depth, start); err != nil {
			return err
		}
		p.n.recordSpan(p.pathString(), "object", start, p.pos)
		return nil
	case c == '[':
		p.pos++
		if err := p.array(w, depth, start); err != nil {
			return err
		}
		p.n.recordSpan(p.pathString(), "array", start, p.pos)
		return nil
	case c == '"':
		s, err := p.string()
		if err != nil {
			return err
		}
		writeJSONString(w, s)
		p.n.recordSpan(p.pathString(), "string", start, p.pos)
		return nil
	case c == 't':
		return p.literal(w, "true", start)
	case c == 'f':
		return p.literal(w, "false", start)
	case c == 'n':
		return p.literal(w, "null", start)
	case c == '-' || isDigit(c):
		lit := p.scanNumber()
		canon, err := canonicalNumber(lit)
		if err != nil {
			return p.errf(start, "invalid number %q", lit)
		}
		io.WriteString(w, canon)
		p.n.recordSpan(p.pathString(), "number", start, p.pos)
		return nil
	}
	return p.errf(p.pos, "unexpected character %q, expected a value", rune(c))
}

func (p *parser) literal(w io.Writer, word string, start int) error {
	if len(p.src)-p.pos < len(word) || string(p.src[p.pos:p.pos+len(word)]) != word {
		return p.errf(start, "invalid literal, expected %q", word)
	}
	end := p.pos + len(word)
	if end < len(p.src) && isIdentChar(p.src[end]) {
		return p.errf(start, "invalid literal, expected %q", word)
	}
	p.pos = end
	io.WriteString(w, word)
	p.n.recordSpan(p.pathString(), word, start, p.pos)
	return nil
}

func (p *parser) scanNumber() string {
	start := p.pos
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if isDigit(c) || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E' {
			p.pos++
		} else {
			break
		}
	}
	return string(p.src[start:p.pos])
}

func (p *parser) string() (string, error) {
	s, next, err := parseJSONString(p.src, p.pos)
	if err != nil {
		return "", err
	}
	p.pos = next
	return s, nil
}

// object parses an object body ('{' already consumed) and writes the
// normalized, key-sorted object to w. When depth == 0 and n.resume is set,
// parsing continues from a checkpoint just past a member value.
func (p *parser) object(w io.Writer, depth, start int) error {
	n := p.n
	ob := &objBuilder{keepSegs: depth == 0 && n.stateDir != ""}

	// afterMember consumes the separator after a member value and reports
	// whether the object is finished. Trailing commas are allowed.
	afterMember := func() (bool, error) {
		if err := p.skipWS(); err != nil {
			return false, err
		}
		if p.pos >= len(p.src) {
			return false, p.errf(p.pos, "unexpected end of input inside object")
		}
		switch p.src[p.pos] {
		case '}':
			p.pos++
			return true, nil
		case ',':
			p.pos++
			if err := p.skipWS(); err != nil {
				return false, err
			}
			if p.pos < len(p.src) && p.src[p.pos] == '}' { // trailing comma
				p.pos++
				return true, nil
			}
			return false, nil
		}
		return false, p.errf(p.pos, "expected ',' or '}' in object")
	}

	if depth == 0 && n.resume != nil {
		ob.segments = n.resume.segments
		done, err := afterMember()
		if err != nil {
			return err
		}
		if done {
			return ob.emit(n, w, p.src)
		}
	} else {
		if err := p.skipWS(); err != nil {
			return err
		}
		if p.pos >= len(p.src) {
			return p.errf(p.pos, "unexpected end of input inside object")
		}
		if p.pos < len(p.src) && p.src[p.pos] == '}' {
			p.pos++
			return ob.emit(n, w, p.src)
		}
	}

	for {
		if err := p.skipWS(); err != nil {
			return err
		}
		if p.pos >= len(p.src) {
			return p.errf(p.pos, "unexpected end of input inside object")
		}
		if p.src[p.pos] != '"' {
			return p.errf(p.pos, "expected string key in object")
		}
		keyOff := p.pos
		key, err := p.string()
		if err != nil {
			return err
		}
		if err := p.skipWS(); err != nil {
			return err
		}
		if p.pos >= len(p.src) || p.src[p.pos] != ':' {
			return p.errf(p.pos, "expected ':' after object key")
		}
		p.pos++
		p.pushKey(key)
		vb := newValueBuf(n)
		verr := p.value(vb, depth+1)
		p.popPath()
		if verr != nil {
			vb.discard()
			return verr
		}
		if vb.err != nil {
			vb.discard()
			return vb.err
		}
		ob.add(n, key, keyOff, vb)
		if n.memUsed > n.budget {
			if err := ob.flush(n); err != nil {
				return err
			}
		}
		if depth == 0 && n.pauseRequested() {
			if n.stateDir == "" {
				return p.errf(p.pos, "interrupted: cannot checkpoint without a state directory (use -state)")
			}
			if err := ob.flush(n); err != nil {
				return err
			}
			if err := n.writeCheckpoint(p.pos, start, ob.segments); err != nil {
				return err
			}
			return errPaused
		}
		done, err := afterMember()
		if err != nil {
			return err
		}
		if done {
			break
		}
	}
	return ob.emit(n, w, p.src)
}

// array parses an array body ('[' already consumed) and streams the
// normalized elements to w in source order. Trailing commas are allowed.
func (p *parser) array(w io.Writer, depth, start int) error {
	io.WriteString(w, "[")
	if err := p.skipWS(); err != nil {
		return err
	}
	if p.pos >= len(p.src) {
		return p.errf(p.pos, "unexpected end of input inside array")
	}
	if p.pos < len(p.src) && p.src[p.pos] == ']' {
		p.pos++
		io.WriteString(w, "]")
		return nil
	}
	i := 0
	first := true
	for {
		if !first {
			io.WriteString(w, ",")
		}
		first = false
		p.pushIndex(i)
		err := p.value(w, depth+1)
		p.popPath()
		if err != nil {
			return err
		}
		i++
		if err := p.skipWS(); err != nil {
			return err
		}
		if p.pos >= len(p.src) {
			return p.errf(p.pos, "unexpected end of input inside array")
		}
		switch p.src[p.pos] {
		case ']':
			p.pos++
			io.WriteString(w, "]")
			return nil
		case ',':
			p.pos++
			if err := p.skipWS(); err != nil {
				return err
			}
			if p.pos < len(p.src) && p.src[p.pos] == ']' { // trailing comma
				p.pos++
				io.WriteString(w, "]")
				return nil
			}
		default:
			return p.errf(p.pos, "expected ',' or ']' in array")
		}
	}
}

func (p *parser) pushKey(key string) { p.path = append(p.path, renderKey(key)) }
func (p *parser) pushIndex(i int)    { p.path = append(p.path, "["+strconv.Itoa(i)+"]") }
func (p *parser) popPath()           { p.path = p.path[:len(p.path)-1] }
func (p *parser) pathString() string { return "$" + strings.Join(p.path, "") }

func renderKey(key string) string {
	ident := len(key) > 0
	for i := 0; i < len(key); i++ {
		c := key[i]
		if !(c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			ident = false
			break
		}
	}
	if ident {
		return "." + key
	}
	return "[" + strconv.Quote(key) + "]"
}

func isIdentChar(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
}
