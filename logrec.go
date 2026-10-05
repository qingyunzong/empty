// Package logrec assembles log records from a byte stream. A record is one
// start line followed by its continuation lines, classified by a finite
// rule table. Input may be fed in arbitrary byte chunks; the final line
// need not end with a newline.
package logrec

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
)

// Kind classifies a line as starting a new record or continuing the
// current one.
type Kind int

const (
	Start Kind = iota
	Continuation
)

func (k Kind) String() string {
	if k == Start {
		return "start"
	}
	return "continuation"
}

// Rule classifies a line by prefix. Rules are consulted in order and the
// first match wins.
type Rule struct {
	Prefix string
	Kind   Kind
}

// MaxRules bounds the rule table.
const MaxRules = 64

// DiagKind identifies the kind of a Diagnostic.
type DiagKind int

const (
	// DiagOrphanContinuation marks a continuation line seen while no
	// record is open. The line is dropped.
	DiagOrphanContinuation DiagKind = iota
	// DiagOversize marks a discarded region: a line exceeding
	// MaxLineBytes plus every following non-start line, up to the next
	// start line or end of input.
	DiagOversize
)

func (k DiagKind) String() string {
	switch k {
	case DiagOrphanContinuation:
		return "orphan-continuation"
	case DiagOversize:
		return "oversize-discard"
	}
	return "unknown"
}

// Diagnostic describes a problem found while parsing. Start and End are
// byte offsets into the input with End exclusive; the range covers whole
// lines including their terminators. Line is the 1-based line number at
// which the problem begins.
type Diagnostic struct {
	Kind  DiagKind
	Start int64
	End   int64
	Line  int
}

// Record is an assembled log record: one start line plus its continuation
// lines, terminators stripped. Offset is the byte offset of the start
// line and Line its 1-based line number.
type Record struct {
	Offset int64
	Line   int
	Lines  []string
}

// Text joins the record lines with "\n".
func (r Record) Text() string { return strings.Join(r.Lines, "\n") }

// Config configures a Parser.
type Config struct {
	// Rules is the finite classification table, first match wins. With
	// rules, unmatched lines are continuations. With no rules, lines
	// starting with a space or tab are continuations and all others are
	// start lines.
	Rules []Rule
	// MaxLineBytes is the maximum line length in bytes, terminator
	// excluded. A longer line is discarded together with every following
	// non-start line, and the discarded byte range is reported as a
	// DiagOversize diagnostic. 0 means unlimited.
	MaxLineBytes int
}

// Parser assembles records from a byte stream. Feed input with Write in
// any chunking and finish with Close.
type Parser struct {
	rules   []Rule
	prefix  [][]byte
	maxLine int

	records []Record
	diags   []Diagnostic

	buf       []byte // bytes of the current line, terminator excluded
	pos       int64  // absolute offset just past the last consumed byte
	lineStart int64  // absolute offset of buf[0]
	lineNo    int

	cur        *Record
	discarding bool
	diagStart  int64
	diagLine   int
}

// New returns a Parser for cfg.
func New(cfg Config) (*Parser, error) {
	if len(cfg.Rules) > MaxRules {
		return nil, fmt.Errorf("logrec: rule table has %d entries, max %d", len(cfg.Rules), MaxRules)
	}
	if cfg.MaxLineBytes < 0 {
		return nil, errors.New("logrec: MaxLineBytes must be >= 0")
	}
	p := &Parser{
		rules:   append([]Rule(nil), cfg.Rules...),
		maxLine: cfg.MaxLineBytes,
	}
	for _, r := range p.rules {
		p.prefix = append(p.prefix, []byte(r.Prefix))
	}
	return p, nil
}

// Records returns the records assembled so far.
func (p *Parser) Records() []Record { return append([]Record(nil), p.records...) }

// Diagnostics returns the diagnostics reported so far.
func (p *Parser) Diagnostics() []Diagnostic { return append([]Diagnostic(nil), p.diags...) }

// Write consumes the next chunk of input. Chunks may split the input at
// any byte boundary.
func (p *Parser) Write(b []byte) {
	for len(b) > 0 {
		i := bytes.IndexByte(b, '\n')
		if i < 0 {
			p.buf = append(p.buf, b...)
			p.pos += int64(len(b))
			return
		}
		p.buf = append(p.buf, b[:i]...)
		p.pos += int64(i) + 1
		p.handleLine()
		p.buf = p.buf[:0]
		p.lineStart = p.pos
		b = b[i+1:]
	}
}

// Close flushes a final line that has no trailing newline and closes any
// open record or discarded region.
func (p *Parser) Close() {
	if len(p.buf) > 0 {
		p.handleLine()
		p.buf = nil
	}
	p.closeRecord()
	if p.discarding {
		p.diags = append(p.diags, Diagnostic{Kind: DiagOversize, Start: p.diagStart, End: p.pos, Line: p.diagLine})
		p.discarding = false
	}
}

// handleLine processes the complete line in p.buf. The line spans
// [p.lineStart, p.pos) in the input, terminator included when present.
func (p *Parser) handleLine() {
	p.lineNo++
	line := p.buf
	if n := len(line); n > 0 && line[n-1] == '\r' {
		line = line[:n-1]
	}
	if p.maxLine > 0 && len(line) > p.maxLine {
		if !p.discarding {
			p.closeRecord()
			p.discarding = true
			p.diagStart = p.lineStart
			p.diagLine = p.lineNo
		}
		return
	}
	kind := p.classify(line)
	if p.discarding {
		if kind != Start {
			return
		}
		p.diags = append(p.diags, Diagnostic{Kind: DiagOversize, Start: p.diagStart, End: p.lineStart, Line: p.diagLine})
		p.discarding = false
	}
	if kind == Start {
		p.closeRecord()
		p.cur = &Record{Offset: p.lineStart, Line: p.lineNo}
		p.cur.Lines = append(p.cur.Lines, string(line))
		return
	}
	if p.cur == nil {
		p.diags = append(p.diags, Diagnostic{Kind: DiagOrphanContinuation, Start: p.lineStart, End: p.pos, Line: p.lineNo})
		return
	}
	p.cur.Lines = append(p.cur.Lines, string(line))
}

func (p *Parser) closeRecord() {
	if p.cur != nil {
		p.records = append(p.records, *p.cur)
		p.cur = nil
	}
}

func (p *Parser) classify(line []byte) Kind {
	for i, pre := range p.prefix {
		if bytes.HasPrefix(line, pre) {
			return p.rules[i].Kind
		}
	}
	if len(p.rules) == 0 {
		if len(line) > 0 && (line[0] == ' ' || line[0] == '\t') {
			return Continuation
		}
		return Start
	}
	return Continuation
}
