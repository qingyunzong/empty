// Package addrlist implements a streaming parser for comma-separated
// address lists.
//
// Supported syntax:
//   - Addresses are separated by commas, but a comma only separates at
//     the top level: commas inside "double quotes" or (parenthesized
//     comments) never split addresses.
//   - Comments are written as ( ... ) and may nest. Comments are removed
//     from the output text.
//   - A backslash escapes the next byte everywhere (inside comments,
//     inside quotes and at the top level). Escaped bytes are kept
//     verbatim in the output; the parser does not unescape them.
//   - A double quote that is not closed is isolated to the end of the
//     physical line: the quote state ends at the next '\n' instead of
//     swallowing the rest of the input.
//   - Domains are not validated; any byte sequence may form an address.
package addrlist

import "strings"

// Address is a single parsed address.
type Address struct {
	// Text is the address with comments removed and surrounding
	// whitespace trimmed. Quotes and backslash escapes are preserved.
	Text string
	// Start and End are byte offsets into the original input spanning
	// the address: from its first non-whitespace, non-comment byte up
	// to and including its last one.
	Start int
	End   int
}

// Parser is a streaming address-list parser. Bytes may be fed in
// arbitrarily sized chunks via Write; the result is identical to
// feeding the whole input at once.
type Parser struct {
	emit func(Address)

	buf     []byte // output text of the current address (comments removed)
	pos     int    // absolute offset of the next input byte
	start   int    // offset of first kept non-space byte, -1 when none
	end     int    // one past the last kept non-space byte
	depth   int    // comment nesting depth, 0 = outside comments
	inQuote bool
	escaped bool
}

// NewParser returns a Parser that calls emit for every completed
// address, in input order.
func NewParser(emit func(Address)) *Parser {
	return &Parser{emit: emit, start: -1}
}

// Parse parses the whole input and returns all addresses.
func Parse(input string) []Address {
	var out []Address
	p := NewParser(func(a Address) { out = append(out, a) })
	p.Write([]byte(input))
	p.Close()
	return out
}

// Write feeds a chunk of input to the parser.
func (p *Parser) Write(b []byte) {
	for _, c := range b {
		p.step(c)
		p.pos++
	}
}

// Close flushes any pending address at end of input.
func (p *Parser) Close() {
	p.flush()
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n'
}

func (p *Parser) step(c byte) {
	switch {
	case p.escaped:
		// Escaped byte: literal everywhere. Inside a comment it is
		// dropped with the rest of the comment; otherwise kept.
		p.escaped = false
		if p.depth == 0 {
			p.keep(c)
		}
	case p.depth > 0:
		switch c {
		case '\\':
			p.escaped = true
		case '(':
			p.depth++
		case ')':
			p.depth--
		}
	case p.inQuote:
		switch c {
		case '\\':
			p.keep(c)
			p.escaped = true
		case '"':
			p.keep(c)
			p.inQuote = false
		case '\n':
			// Unclosed quote: isolate it to the physical line.
			// The newline itself acts as ordinary whitespace.
			p.keep(c)
			p.inQuote = false
		default:
			p.keep(c)
		}
	default:
		switch c {
		case '\\':
			p.keep(c)
			p.escaped = true
		case '"':
			p.keep(c)
			p.inQuote = true
		case '(':
			p.depth = 1
		case ',':
			p.flush()
		default:
			p.keep(c)
		}
	}
}

// keep records a byte that belongs to the current address.
func (p *Parser) keep(c byte) {
	if p.start < 0 && isSpace(c) {
		return // leading whitespace is not part of the address
	}
	p.buf = append(p.buf, c)
	if p.start < 0 {
		p.start = p.pos
	}
	if !isSpace(c) {
		p.end = p.pos + 1
	}
}

// flush emits the current address, unless it is empty.
func (p *Parser) flush() {
	if p.start >= 0 {
		p.emit(Address{
			Text:  strings.TrimRight(string(p.buf), " \t\r\n"),
			Start: p.start,
			End:   p.end,
		})
	}
	p.buf = p.buf[:0]
	p.start = -1
	p.end = 0
}
