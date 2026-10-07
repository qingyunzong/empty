package logparse

import (
	"bytes"
	"fmt"
	"strings"
)

// Entry is a single parsed key=value occurrence. Keys are canonicalized
// through the alias configuration in effect for the entry's line.
type Entry struct {
	Key   string // canonical key
	Value string // bare keys yield "true"; "key=" yields ""
	Line  int    // 1-based physical line number
}

// ParseError describes a malformed token. The error is quarantined to its
// physical line: entries already parsed on that line are kept, the rest of
// the line is skipped, and subsequent lines are parsed normally.
type ParseError struct {
	Line  int    // 1-based physical line number
	Start int    // byte offset of the offending token within the line
	End   int    // byte offset just past the offending sequence
	Raw   string // raw text of line[Start:End]
	Msg   string // human-readable cause
}

func (e ParseError) Error() string {
	return fmt.Sprintf("logparse: line %d: %s (%q)", e.Line, e.Msg, e.Raw)
}

// Parser is a streaming key=value log parser. Input is supplied in
// arbitrary chunks via Feed; records are split on physical lines ('\n',
// with a trailing '\r' tolerated).
type Parser struct {
	cfg     *Config // config for lines that have not started yet
	lineCfg *Config // config snapshot for the partially buffered line
	buf     []byte  // bytes of the current incomplete line
	lineNo  int
	entries []Entry
	errs    []ParseError
}

// NewParser returns a Parser using cfg. If cfg is nil, an empty Config is
// used.
func NewParser(cfg *Config) *Parser {
	if cfg == nil {
		cfg = NewConfig()
	}
	return &Parser{cfg: cfg}
}

// SetConfig hot-reloads the configuration. The new config applies only to
// lines whose first byte has not yet been fed; a line currently spanning
// chunks keeps the rules in effect when it started.
func (p *Parser) SetConfig(cfg *Config) {
	if cfg == nil {
		cfg = NewConfig()
	}
	p.cfg = cfg
}

// Feed consumes a chunk of input, parsing every physical line it
// completes. A trailing partial line is buffered until more data or Close.
func (p *Parser) Feed(chunk []byte) {
	for len(chunk) > 0 {
		if p.lineCfg == nil {
			p.lineCfg = p.cfg
		}
		idx := bytes.IndexByte(chunk, '\n')
		if idx < 0 {
			p.buf = append(p.buf, chunk...)
			return
		}
		p.buf = append(p.buf, chunk[:idx]...)
		p.lineNo++
		p.emitLine()
		chunk = chunk[idx+1:]
	}
}

// Close flushes any buffered partial line as a final record.
func (p *Parser) Close() {
	if p.lineCfg == nil && len(p.buf) == 0 {
		return
	}
	if p.lineCfg == nil {
		p.lineCfg = p.cfg
	}
	p.lineNo++
	p.emitLine()
}

func (p *Parser) emitLine() {
	line := strings.TrimSuffix(string(p.buf), "\r")
	parseLine(line, p.lineNo, p.lineCfg, &p.entries, &p.errs)
	p.buf = p.buf[:0]
	p.lineCfg = nil
}

// Entries returns all parsed entries in input order.
func (p *Parser) Entries() []Entry {
	return append([]Entry(nil), p.entries...)
}

// Errors returns all parse errors in input order.
func (p *Parser) Errors() []ParseError {
	return append([]ParseError(nil), p.errs...)
}

// Values groups entry values by canonical key, preserving order of
// appearance. Duplicate keys (after alias resolution) keep every value.
func (p *Parser) Values() map[string][]string {
	m := make(map[string][]string, len(p.entries))
	for _, e := range p.entries {
		m[e.Key] = append(m[e.Key], e.Value)
	}
	return m
}

// tokenError pinpoints a malformed escape/quote sequence within a line.
type tokenError struct {
	pos int // byte offset where the offending sequence starts
	end int // byte offset just past the offending sequence
	msg string
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' }

// parseLine tokenizes one physical line, appending entries and at most one
// error (the line is abandoned after the first malformed token).
func parseLine(line string, lineNo int, cfg *Config, entries *[]Entry, errs *[]ParseError) {
	i, n := 0, len(line)
	for i < n {
		for i < n && isSpace(line[i]) {
			i++
		}
		if i >= n {
			break
		}
		start := i
		for i < n && line[i] != '=' && !isSpace(line[i]) {
			i++
		}
		key := line[start:i]
		if key == "" {
			*errs = append(*errs, ParseError{
				Line: lineNo, Start: start, End: start + 1,
				Raw: line[start : start+1], Msg: "missing key before '='",
			})
			return
		}
		if i >= n || isSpace(line[i]) {
			// Bare key: boolean true.
			*entries = append(*entries, Entry{Key: cfg.Canonical(key), Value: "true", Line: lineNo})
			continue
		}
		i++ // consume '='
		val, terr := parseValue(line, &i)
		if terr != nil {
			*errs = append(*errs, ParseError{
				Line: lineNo, Start: start, End: terr.end,
				Raw: line[start:terr.end], Msg: terr.msg,
			})
			return
		}
		*entries = append(*entries, Entry{Key: cfg.Canonical(key), Value: val, Line: lineNo})
	}
}

// parseValue parses a value starting at *i, which is either a double-quoted
// string or a bare token terminated by whitespace or end of line.
func parseValue(line string, i *int) (string, *tokenError) {
	if *i < len(line) && line[*i] == '"' {
		return parseQuoted(line, i)
	}
	return parseBare(line, i)
}

func parseBare(line string, i *int) (string, *tokenError) {
	var b strings.Builder
	for *i < len(line) {
		c := line[*i]
		if isSpace(c) {
			break
		}
		if c == '\\' {
			r, terr := unescapeAt(line, *i)
			if terr != nil {
				return "", terr
			}
			b.WriteByte(r)
			*i += 2
			continue
		}
		b.WriteByte(c)
		*i++
	}
	return b.String(), nil
}

func parseQuoted(line string, i *int) (string, *tokenError) {
	quotePos := *i
	*i++ // consume opening quote
	var b strings.Builder
	for *i < len(line) {
		c := line[*i]
		if c == '"' {
			*i++
			if *i < len(line) && !isSpace(line[*i]) {
				return "", &tokenError{pos: *i, end: *i + 1,
					msg: "unexpected character after closing quote"}
			}
			return b.String(), nil
		}
		if c == '\\' {
			r, terr := unescapeAt(line, *i)
			if terr != nil {
				return "", terr
			}
			b.WriteByte(r)
			*i += 2
			continue
		}
		b.WriteByte(c)
		*i++
	}
	return "", &tokenError{pos: quotePos, end: len(line),
		msg: "unterminated quoted value"}
}

// unescapeAt decodes the escape sequence starting at line[pos] (a
// backslash). Recognized escapes: \n \t \r \\ \" \' and backslash-space.
func unescapeAt(line string, pos int) (byte, *tokenError) {
	if pos+1 >= len(line) {
		return 0, &tokenError{pos: pos, end: pos + 1, msg: "trailing backslash"}
	}
	switch line[pos+1] {
	case 'n':
		return '\n', nil
	case 't':
		return '\t', nil
	case 'r':
		return '\r', nil
	case '\\':
		return '\\', nil
	case '"':
		return '"', nil
	case '\'':
		return '\'', nil
	case ' ':
		return ' ', nil
	}
	return 0, &tokenError{pos: pos, end: pos + 2,
		msg: fmt.Sprintf("invalid escape %q", "\\"+string(line[pos+1]))}
}
