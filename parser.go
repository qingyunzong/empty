package dataeng

import (
	"fmt"
	"strconv"
)

// Envelope is a fully validated BEGIN..END block delivered to the host.
type Envelope struct {
	ControlID string
	Rows      [][]string // payload fields of each ROW segment (type field excluded)
	Offset    int64      // absolute source offset of the first byte of BEGIN
	RawBytes  int        // raw source bytes spanned by the envelope
}

// ParseError reports a stream violation at an absolute source offset.
type ParseError struct {
	Offset int64
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("offset %d: %s", e.Offset, e.Reason)
}

type parserState int

const (
	stateHeader parserState = iota
	stateSegment
	stateEscape
	stateSkip       // discarding the remainder of a failed segment
	stateSkipEscape // discarding an escaped byte inside a failed segment
)

type envelopeState struct {
	controlID   string
	rows        [][]string
	rawBytes    int
	startOffset int64
}

// Parser is a streaming decoder for delimited exchange envelopes. The first
// three bytes of the stream declare the field separator, segment terminator
// and escape character; they must be distinct ASCII bytes.
type Parser struct {
	fieldBudget    int
	envelopeBudget int

	state     parserState
	header    []byte
	sep       byte
	term      byte
	esc       byte
	offset    int64 // absolute offset of the next byte to consume
	segStart  int64 // absolute offset of the current segment's first byte
	segRaw    int   // raw bytes consumed by the current segment
	boundary  bool  // next byte starts a new segment
	field     []byte
	fields    []string
	env       *envelopeState
	finished  bool
	lastError *ParseError
}

// NewParser builds a Parser. Both budgets must be positive: fieldBudget caps
// the decoded length of any single field, envelopeBudget caps the raw source
// bytes spanned by one envelope.
func NewParser(fieldBudget, envelopeBudget int) (*Parser, error) {
	if fieldBudget <= 0 {
		return nil, fmt.Errorf("field budget must be a positive integer, got %d", fieldBudget)
	}
	if envelopeBudget <= 0 {
		return nil, fmt.Errorf("envelope budget must be a positive integer, got %d", envelopeBudget)
	}
	return &Parser{
		fieldBudget:    fieldBudget,
		envelopeBudget: envelopeBudget,
		state:          stateHeader,
	}, nil
}

// Feed consumes a chunk of the stream and returns every envelope completed by
// it. On the first violation the current envelope is revoked, the parser
// resynchronises at the next segment boundary, and a *ParseError carrying the
// absolute source offset is returned; envelopes completed earlier are kept.
func (p *Parser) Feed(data []byte) ([]Envelope, error) {
	if p.finished {
		return nil, fmt.Errorf("parser already finished")
	}
	var done []Envelope
	var firstErr error
	for _, b := range data {
		if env := p.step(b); env != nil {
			done = append(done, *env)
		}
		if firstErr == nil && p.lastError != nil {
			firstErr = p.lastError
		}
	}
	return done, firstErr
}

// Finish signals end of stream. It fails if the stream ends inside the
// header, a segment or an envelope.
func (p *Parser) Finish() error {
	p.finished = true
	switch {
	case p.state == stateHeader && len(p.header) > 0:
		return &ParseError{Offset: p.offset, Reason: "truncated header"}
	case p.state == stateHeader:
		return nil
	case p.state == stateEscape:
		return &ParseError{Offset: p.offset, Reason: "truncated escape sequence"}
	case p.state == stateSkip || p.state == stateSkipEscape:
		return &ParseError{Offset: p.offset, Reason: "truncated segment"}
	case p.state == stateSegment && (len(p.field) > 0 || len(p.fields) > 0):
		return &ParseError{Offset: p.offset, Reason: "truncated segment"}
	case p.env != nil:
		return &ParseError{Offset: p.offset, Reason: "truncated envelope"}
	}
	return nil
}

func (p *Parser) fail(off int64, reason string) {
	if p.lastError == nil {
		p.lastError = &ParseError{Offset: off, Reason: reason}
	}
}

func (p *Parser) step(b byte) *Envelope {
	p.lastError = nil
	off := p.offset
	p.offset++

	if p.state == stateHeader {
		p.header = append(p.header, b)
		if len(p.header) == 3 {
			if err := p.checkHeader(); err != nil {
				p.fail(off, err.Error())
			} else {
				p.boundary = true
			}
		}
		return nil
	}

	if p.boundary {
		p.segStart = off
		p.segRaw = 0
		p.boundary = false
	}
	p.segRaw++

	if p.env != nil {
		p.env.rawBytes++
		if p.env.rawBytes > p.envelopeBudget {
			p.abort()
			p.fail(off, "envelope raw byte budget exceeded")
			p.state = stateSkip
			if b == p.esc {
				p.state = stateSkipEscape
			} else if b == p.term {
				p.state = stateSegment
				p.boundary = true
			}
			return nil
		}
	}

	switch p.state {
	case stateSkip:
		if b == p.esc {
			p.state = stateSkipEscape
		} else if b == p.term {
			p.state = stateSegment
			p.boundary = true
		}
	case stateSkipEscape:
		p.state = stateSkip
	case stateEscape:
		p.state = stateSegment
		p.appendFieldByte(b, off)
	case stateSegment:
		switch b {
		case p.esc:
			p.state = stateEscape
		case p.sep:
			p.fields = append(p.fields, string(p.field))
			p.field = p.field[:0]
		case p.term:
			p.fields = append(p.fields, string(p.field))
			p.field = p.field[:0]
			env := p.closeSegment(off)
			p.fields = p.fields[:0]
			p.boundary = true
			return env
		default:
			p.appendFieldByte(b, off)
		}
	}
	return nil
}

func (p *Parser) appendFieldByte(b byte, off int64) {
	if len(p.field) >= p.fieldBudget {
		if p.env != nil {
			p.abort()
		}
		p.fail(off, "field byte budget exceeded")
		p.state = stateSkip
		return
	}
	p.field = append(p.field, b)
}

func (p *Parser) checkHeader() error {
	for i, c := range p.header {
		if c >= 0x80 {
			p.header = p.header[:0]
			return fmt.Errorf("header byte %d is not ASCII", i)
		}
	}
	if p.header[0] == p.header[1] || p.header[1] == p.header[2] || p.header[0] == p.header[2] {
		p.header = p.header[:0]
		return fmt.Errorf("header bytes must be distinct")
	}
	p.sep, p.term, p.esc = p.header[0], p.header[1], p.header[2]
	p.header = nil
	p.state = stateSegment
	return nil
}

func (p *Parser) abort() {
	p.env = nil
	p.field = p.field[:0]
	p.fields = p.fields[:0]
}

// closeSegment validates the just-terminated segment. It returns a completed
// envelope when an END segment passes all checks.
func (p *Parser) closeSegment(off int64) *Envelope {
	typ := p.fields[0]
	if p.env == nil {
		if typ != "BEGIN" {
			p.fail(off, fmt.Sprintf("segment %q outside envelope", typ))
			return nil
		}
		if len(p.fields) != 2 {
			p.fail(off, fmt.Sprintf("BEGIN requires exactly 2 fields, got %d", len(p.fields)))
			return nil
		}
		if p.fields[1] == "" {
			p.fail(off, "BEGIN control ID must not be empty")
			return nil
		}
		p.env = &envelopeState{
			controlID:   p.fields[1],
			rawBytes:    p.segRaw,
			startOffset: p.segStart,
		}
		return nil
	}

	switch typ {
	case "BEGIN":
		p.abort()
		p.fail(off, "nested BEGIN")
	case "ROW":
		row := make([]string, len(p.fields)-1)
		copy(row, p.fields[1:])
		p.env.rows = append(p.env.rows, row)
	case "END":
		env := p.env
		p.env = nil
		if len(p.fields) != 3 {
			p.fail(off, fmt.Sprintf("END requires exactly 3 fields, got %d", len(p.fields)))
			return nil
		}
		if p.fields[1] != env.controlID {
			p.fail(off, fmt.Sprintf("END control ID %q does not match %q", p.fields[1], env.controlID))
			return nil
		}
		count, ok := parseCount(p.fields[2])
		if !ok {
			p.fail(off, fmt.Sprintf("invalid row count %q", p.fields[2]))
			return nil
		}
		if count != len(env.rows) {
			p.fail(off, fmt.Sprintf("row count mismatch: END declares %d, envelope has %d", count, len(env.rows)))
			return nil
		}
		return &Envelope{
			ControlID: env.controlID,
			Rows:      env.rows,
			Offset:    env.startOffset,
			RawBytes:  env.rawBytes,
		}
	default:
		p.abort()
		p.fail(off, fmt.Sprintf("unknown segment type %q", typ))
	}
	return nil
}

// parseCount accepts only a non-negative decimal without leading zeros.
func parseCount(s string) (int, bool) {
	if s == "" {
		return 0, false
	}
	if len(s) > 1 && s[0] == '0' {
		return 0, false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, false
	}
	return n, true
}
