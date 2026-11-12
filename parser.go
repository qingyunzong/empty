package dataeng

import (
	"encoding/binary"
	"errors"
	"strconv"
	"unicode/utf8"
)

// Magic prefixes every stream.
var Magic = [4]byte{'R', 'O', 'W', '1'}

// FieldType identifies how a column's body bytes are interpreted.
type FieldType uint8

const (
	// Raw stores body bytes verbatim without validation.
	Raw FieldType = iota
	// Integer requires an eight-byte big-endian signed integer body.
	Integer
	// Text requires the body to be valid, strict UTF-8.
	Text
)

// ErrorCode classifies a parse failure.
type ErrorCode uint8

const (
	ErrMagicMismatch ErrorCode = iota + 1
	ErrTruncated
	ErrIllegalFieldCount
	ErrFieldCountMismatch
	ErrIllegalLength
	ErrIntegerLength
	ErrIllegalUTF8
	ErrBytesAfterTerminator
	ErrFieldLimit
	ErrRowLimit
)

func (c ErrorCode) String() string {
	switch c {
	case ErrMagicMismatch:
		return "magic mismatch"
	case ErrTruncated:
		return "truncated stream"
	case ErrIllegalFieldCount:
		return "illegal negative field count"
	case ErrFieldCountMismatch:
		return "field count does not match schema columns"
	case ErrIllegalLength:
		return "illegal negative field length"
	case ErrIntegerLength:
		return "integer field body is not eight bytes"
	case ErrIllegalUTF8:
		return "invalid UTF-8 sequence"
	case ErrBytesAfterTerminator:
		return "bytes after terminator"
	case ErrFieldLimit:
		return "field body exceeds byte limit"
	case ErrRowLimit:
		return "row body exceeds cumulative byte limit"
	default:
		return "parse error"
	}
}

// ParseError carries a failure code and the absolute stream offset at which
// the failure is reported. Illegal prefixes and numeric lengths report the
// start of their prefix; illegal UTF-8 reports the first byte of the
// offending sequence; truncation reports the total number of input bytes;
// other illegal bytes report that byte's absolute offset.
type ParseError struct {
	Code   ErrorCode
	Offset int64
}

func (e *ParseError) Error() string {
	return "dataeng: " + e.Code.String() + " at offset " + strconv.FormatInt(e.Offset, 10)
}

// ErrPaused is returned by Feed while a row callback has paused the parser
// and by End/Resume attempts that cannot proceed in the paused state.
var ErrPaused = errors.New("dataeng: parser paused awaiting resume")

// Field is one parsed column value. Null is independent of an empty body:
// a NULL field has Null == true, an empty non-null field has Null == false
// with an empty Data slice.
type Field struct {
	Type FieldType
	Null bool
	Data []byte
	// Int is populated only for non-null Integer fields.
	Int int64
	// Text is populated only for non-null Text fields.
	Text string
}

// Row is a complete, type-validated row delivered to the callback.
type Row struct {
	Index  int
	Fields []Field
}

// Callback receives every complete row. Returning true pauses the parser:
// the row counts as delivered, Feed returns the consumed position inside
// the current chunk, and Resume continues without redelivering the row.
type Callback func(row Row) (pause bool)

// Config configures a Parser. Columns describes the fixed schema and is
// copied by NewParser. MaxFieldBytes and MaxRowBytes, when positive, cap a
// single field body and the cumulative non-null body bytes of one row; a
// zero or negative value means unlimited.
type Config struct {
	Columns       []FieldType
	MaxFieldBytes int64
	MaxRowBytes   int64
	Callback      Callback
}

type parserState uint8

const (
	stateMagic parserState = iota
	stateFieldCount
	stateLength
	stateBody
	stateDone
)

// Parser incrementally parses a binary row stream. It is not safe for
// concurrent use.
type Parser struct {
	columns       []FieldType
	maxFieldBytes int64
	maxRowBytes   int64
	callback      Callback

	buf  []byte
	base int64 // absolute stream offset of buf[0]
	pos  int   // read position within buf

	state     parserState
	magicSeen int
	col       int
	bodyLen   int
	rowBody   int64
	fields    []Field

	paused     bool
	fatal      *ParseError
	delivered  []Row
	deliverCnt int
}

// NewParser constructs a parser for the given schema configuration.
func NewParser(cfg Config) *Parser {
	columns := make([]FieldType, len(cfg.Columns))
	copy(columns, cfg.Columns)
	return &Parser{
		columns:       columns,
		maxFieldBytes: cfg.MaxFieldBytes,
		maxRowBytes:   cfg.MaxRowBytes,
		callback:      cfg.Callback,
		fields:        make([]Field, len(cfg.Columns)),
		state:         stateMagic,
	}
}

// Feed appends chunk to the internal buffer and parses as many complete
// frames as possible. It returns the number of chunk bytes consumed. When a
// callback pauses, consumed is the position inside this chunk at which the
// pause took effect and the returned error is ErrPaused. After a parse
// error the error remains sticky; already delivered rows are retained.
func (p *Parser) Feed(chunk []byte) (consumed int, err error) {
	if p.fatal != nil {
		return 0, p.fatal
	}
	if p.paused {
		return 0, ErrPaused
	}
	buffered := len(p.buf)
	p.buf = append(p.buf, chunk...)
	parseErr := p.process()
	if parseErr != nil && !errors.Is(parseErr, ErrPaused) {
		if perr, ok := parseErr.(*ParseError); ok {
			p.fatal = perr
		}
	}
	// Bytes read beyond the previously buffered portion are chunk bytes.
	consumed = p.pos - buffered
	if consumed < 0 {
		consumed = 0
	}
	if consumed > len(chunk) {
		consumed = len(chunk)
	}
	p.compact()
	return consumed, parseErr
}

// Resume clears a pause and continues parsing buffered input. The row that
// triggered the pause is not redelivered.
func (p *Parser) Resume() error {
	if p.fatal != nil {
		return p.fatal
	}
	if !p.paused {
		return nil
	}
	p.paused = false
	err := p.process()
	if err != nil && !errors.Is(err, ErrPaused) {
		if perr, ok := err.(*ParseError); ok {
			p.fatal = perr
		}
	}
	p.compact()
	return err
}

// End signals that no further input will arrive. It reports a truncation
// error, offset at the total input length, when the terminator was not yet
// received. It returns ErrPaused while a callback pause is outstanding.
func (p *Parser) End() error {
	if p.fatal != nil {
		return p.fatal
	}
	if p.paused {
		return ErrPaused
	}
	if p.state != stateDone {
		p.fatal = &ParseError{Code: ErrTruncated, Offset: p.base + int64(len(p.buf))}
		return p.fatal
	}
	return nil
}

// Paused reports whether the parser is waiting for Resume.
func (p *Parser) Paused() bool { return p.paused }

// Fatal returns the sticky parse error, if any.
func (p *Parser) Fatal() *ParseError { return p.fatal }

// Rows returns all rows delivered so far, including rows delivered before a
// later parse error.
func (p *Parser) Rows() []Row { return p.delivered }

// Delivered returns the number of delivered rows.
func (p *Parser) Delivered() int { return p.deliverCnt }

func (p *Parser) fail(code ErrorCode, offset int64) error {
	return &ParseError{Code: code, Offset: offset}
}

// compact drops consumed prefix bytes and reclaims room after each drive.
func (p *Parser) compact() {
	if p.pos == 0 {
		return
	}
	p.base += int64(p.pos)
	remaining := len(p.buf) - p.pos
	if remaining == 0 {
		p.buf = p.buf[:0]
	} else {
		copy(p.buf, p.buf[p.pos:])
		p.buf = p.buf[:remaining]
	}
	p.pos = 0
}

func (p *Parser) process() error {
	for {
		switch p.state {
		case stateMagic:
			if p.magicSeen < len(Magic) {
				if p.pos >= len(p.buf) {
					return nil
				}
				off := p.base + int64(p.pos)
				b := p.buf[p.pos]
				if b != Magic[p.magicSeen] {
					return p.fail(ErrMagicMismatch, off)
				}
				p.pos++
				p.magicSeen++
				if p.magicSeen < len(Magic) {
					continue
				}
			}
			p.state = stateFieldCount

		case stateFieldCount:
			if len(p.buf)-p.pos < 2 {
				return nil
			}
			off := p.base + int64(p.pos)
			n := int16(binary.BigEndian.Uint16(p.buf[p.pos : p.pos+2]))
			p.pos += 2
			if n < 0 {
				if n == -1 {
					p.state = stateDone
					continue
				}
				return p.fail(ErrIllegalFieldCount, off)
			}
			if int(n) != len(p.columns) {
				return p.fail(ErrFieldCountMismatch, off)
			}
			p.col = 0
			p.rowBody = 0
			if len(p.columns) == 0 {
				if err := p.deliver(); err != nil {
					return err
				}
				p.state = stateFieldCount
				continue
			}
			p.state = stateLength

		case stateLength:
			if len(p.buf)-p.pos < 4 {
				return nil
			}
			off := p.base + int64(p.pos)
			length := int32(binary.BigEndian.Uint32(p.buf[p.pos : p.pos+4]))
			p.pos += 4
			if length < 0 {
				if length == -1 {
					p.fields[p.col] = Field{Type: p.columns[p.col], Null: true}
					if err := p.nextFieldOrDeliver(); err != nil {
						return err
					}
					continue
				}
				return p.fail(ErrIllegalLength, off)
			}
			if p.maxFieldBytes > 0 && int64(length) > p.maxFieldBytes {
				return p.fail(ErrFieldLimit, off)
			}
			if p.maxRowBytes > 0 && p.rowBody+int64(length) > p.maxRowBytes {
				return p.fail(ErrRowLimit, off)
			}
			if p.columns[p.col] == Integer && length != 8 {
				return p.fail(ErrIntegerLength, off)
			}
			p.bodyLen = int(length)
			p.state = stateBody

		case stateBody:
			if len(p.buf)-p.pos < p.bodyLen {
				return nil
			}
			bodyStart := p.base + int64(p.pos)
			body := make([]byte, p.bodyLen)
			copy(body, p.buf[p.pos:p.pos+p.bodyLen])
			p.pos += p.bodyLen
			field := Field{Type: p.columns[p.col], Data: body}
			switch p.columns[p.col] {
			case Integer:
				field.Int = int64(binary.BigEndian.Uint64(body))
			case Text:
				if !utf8.Valid(body) {
					return p.fail(ErrIllegalUTF8, bodyStart+int64(invalidUTF8Offset(body)))
				}
				field.Text = string(body)
			}
			p.rowBody += int64(p.bodyLen)
			p.fields[p.col] = field
			if err := p.nextFieldOrDeliver(); err != nil {
				return err
			}

		case stateDone:
			if p.pos >= len(p.buf) {
				return nil
			}
			return p.fail(ErrBytesAfterTerminator, p.base+int64(p.pos))
		}
	}
}

func (p *Parser) nextFieldOrDeliver() error {
	p.col++
	if p.col < len(p.columns) {
		p.state = stateLength
		return nil
	}
	err := p.deliver()
	p.state = stateFieldCount
	return err
}

func (p *Parser) deliver() error {
	row := Row{Index: p.deliverCnt, Fields: make([]Field, len(p.fields))}
	copy(row.Fields, p.fields)
	p.deliverCnt++
	p.delivered = append(p.delivered, row)
	if p.callback != nil && p.callback(row) {
		p.paused = true
		return ErrPaused
	}
	return nil
}

// invalidUTF8Offset returns the byte index of the first invalid UTF-8
// sequence inside s.
func invalidUTF8Offset(s []byte) int {
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRune(s[i:])
		if r == utf8.RuneError && size == 1 {
			return i
		}
		i += size
	}
	return 0
}
