// Package addrlst parses address lists with RFC 5322-style lexical rules:
// double-quoted strings, backslash escapes, and nestable parenthesized
// comments. Commas split addresses only at the top level. Domains are not
// validated; this is a purely lexical tokenizer.
package addrlst

import (
	"bytes"
	"io"
)

// Address is one parsed address. Clean is the comment-stripped text
// (quoted strings are preserved verbatim, including their quotes).
// Start and End are byte offsets [Start, End) of the address in the
// original input, excluding surrounding whitespace and the separating
// comma. Comments inside that span are still covered by it.
type Address struct {
	Clean string
	Start int
	End   int
}

type state int

const (
	stText state = iota
	stQuote
	stComment
)

// Parser is an incremental address-list parser. Feed bytes with Write in
// arbitrarily sized chunks, then call Close to collect the results.
type Parser struct {
	results []Address
	raw     []byte // raw bytes of the current address
	clean   []byte // comment-stripped bytes of the current address
	base    int    // absolute offset of raw[0]
	pos     int    // absolute offset of the byte currently being processed
	state   state
	depth   int  // comment nesting depth
	escaped bool // previous byte was a backslash (in quote or comment)
}

// NewParser returns a ready-to-use incremental parser.
func NewParser() *Parser { return &Parser{} }

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n'
}

// Write feeds one chunk of input. Chunk boundaries may fall anywhere,
// including inside quotes, escapes, or comments.
func (p *Parser) Write(b []byte) {
	for _, c := range b {
		p.step(c)
		p.pos++
	}
}

// Close finalizes parsing and returns all parsed addresses.
func (p *Parser) Close() []Address {
	p.emit()
	return p.results
}

func (p *Parser) step(c byte) {
	switch p.state {
	case stQuote:
		switch {
		case p.escaped:
			p.escaped = false
			p.appendBoth(c)
		case c == '\\':
			p.escaped = true
			p.appendBoth(c)
		case c == '"':
			p.state = stText
			p.appendBoth(c)
		case c == '\r' || c == '\n':
			// Unclosed quote: isolate it to the end of the physical
			// line. The line terminator itself is top-level whitespace.
			p.state = stText
			p.appendBoth(c)
		default:
			p.appendBoth(c)
		}
	case stComment:
		switch {
		case p.escaped:
			p.escaped = false
			p.appendRaw(c)
		case c == '\\':
			p.escaped = true
			p.appendRaw(c)
		case c == '(':
			p.depth++
			p.appendRaw(c)
		case c == ')':
			p.depth--
			p.appendRaw(c)
			if p.depth == 0 {
				p.state = stText
			}
		default:
			// Comments may span physical lines; an unclosed comment
			// simply runs to EOF.
			p.appendRaw(c)
		}
	default: // stText
		switch c {
		case ',':
			p.emit()
			p.base = p.pos + 1
		case '"':
			p.state = stQuote
			p.escaped = false
			p.appendBoth(c)
		case '(':
			p.state = stComment
			p.depth = 1
			p.escaped = false
			p.appendRaw(c)
		default:
			p.appendBoth(c)
		}
	}
}

func (p *Parser) appendRaw(c byte) { p.raw = append(p.raw, c) }
func (p *Parser) appendBoth(c byte) {
	p.raw = append(p.raw, c)
	p.clean = append(p.clean, c)
}

// emit flushes the current address, trimming surrounding whitespace and
// dropping entries that are empty once comments are removed.
func (p *Parser) emit() {
	lo := 0
	for lo < len(p.raw) && isSpace(p.raw[lo]) {
		lo++
	}
	hi := len(p.raw)
	for hi > lo && isSpace(p.raw[hi-1]) {
		hi--
	}
	clean := bytes.TrimSpace(p.clean)
	if hi > lo && len(clean) > 0 {
		p.results = append(p.results, Address{
			Clean: string(clean),
			Start: p.base + lo,
			End:   p.base + hi,
		})
	}
	p.raw = p.raw[:0]
	p.clean = p.clean[:0]
}

// ParseString parses a whole address list held in memory.
func ParseString(s string) []Address {
	p := NewParser()
	p.Write([]byte(s))
	return p.Close()
}

// ParseReader parses an address list from r, reading in chunks of chunkSize
// bytes (chunkSize <= 0 uses a 64 KiB default). The result is identical to
// reading all of r into memory and calling ParseString.
func ParseReader(r io.Reader, chunkSize int) ([]Address, error) {
	if chunkSize <= 0 {
		chunkSize = 64 * 1024
	}
	p := NewParser()
	buf := make([]byte, chunkSize)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			p.Write(buf[:n])
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	return p.Close(), nil
}
