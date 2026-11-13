package dataeng

import (
	"bytes"
	"errors"
	"io"
	"strings"
)

// Reader consumes a delimited-text stream from an io.Reader. Input may be
// delivered in arbitrarily small or large chunks; the parser never depends on
// read boundaries.
//
// The exported configuration fields may be changed before the first Read.
// They mirror the common encoding/csv configuration names and add the byte
// oriented Delimiter/Quote fields needed for multi-byte tokens.
type Reader struct {
	Delimiter []byte
	Quote     []byte
	// Comment is the single-rune comment prefix, matching encoding/csv.
	// CommentBytes is the byte-oriented extension for multi-byte prefixes.
	Comment      rune
	CommentBytes []byte

	Comma       rune
	QuoteRune   rune
	CommentRune rune

	LazyQuotes       bool
	TrimLeadingSpace bool
	FieldsPerRecord  int
	MaxFieldSize     int
	MaxRecordSize    int
	KeepEmptyLines   bool
	SkipEmptyLines   bool

	src io.Reader

	scan  *scanner
	queue []*Record
	buf   []byte

	current    *Record
	done       bool
	fatalErr   error
	initErr    error
	lastOffset int64
}

// NewReader creates a streaming reader. The arguments may contain an io.Reader
// (or string/[]byte, which are wrapped in an in-memory reader), any number of
// Option values, and Config or *Config values. This keeps the constructor
// convenient whether callers prefer options or a configuration struct.
func NewReader(args ...any) *Reader {
	r := &Reader{
		buf:   make([]byte, 32*1024),
		Comma: ',',
	}
	var opts []Option
	for _, arg := range args {
		switch v := arg.(type) {
		case nil:
		case io.Reader:
			r.src = v
		case string:
			if r.src == nil {
				r.src = strings.NewReader(v)
			} else {
				opts = append(opts, WithDelimiter(v))
			}
		case []byte:
			if r.src == nil {
				r.src = bytes.NewReader(v)
			} else {
				opts = append(opts, WithDelimiter(v))
			}
		case byte:
			opts = append(opts, WithDelimiter(v))
		case rune:
			opts = append(opts, WithDelimiter(v))
		case Config:
			r.applyConfig(v)
		case *Config:
			if v != nil {
				r.applyConfig(*v)
			}
		case Option:
			opts = append(opts, v)
		}
	}
	r.applyOptions(opts)
	if r.src == nil {
		r.src = strings.NewReader("")
	}
	return r
}

// NewReaderE is NewReader with eager validation of the configuration.
func NewReaderE(r io.Reader, args ...any) (*Reader, error) {
	all := make([]any, 0, len(args)+1)
	all = append(all, r)
	all = append(all, args...)
	rd := NewReader(all...)
	if err := rd.init(); err != nil {
		return nil, err
	}
	return rd, nil
}

func (r *Reader) applyConfig(c Config) {
	if c.Delimiter != nil {
		r.Delimiter = append([]byte(nil), c.Delimiter...)
	}
	if c.Quote != nil {
		r.Quote = append([]byte(nil), c.Quote...)
	}
	if c.Comment != nil {
		r.CommentBytes = append([]byte(nil), c.Comment...)
	}
	if c.Comma != 0 {
		r.Comma = c.Comma
	}
	if c.QuoteRune != 0 {
		r.QuoteRune = c.QuoteRune
	}
	if c.CommentRune != 0 {
		r.Comment = c.CommentRune
		r.CommentRune = c.CommentRune
	}
	r.LazyQuotes = r.LazyQuotes || c.LazyQuotes
	r.TrimLeadingSpace = r.TrimLeadingSpace || c.TrimLeadingSpace
	if c.FieldsPerRecord != 0 {
		r.FieldsPerRecord = c.FieldsPerRecord
	}
	if c.MaxFieldSize != 0 {
		r.MaxFieldSize = c.MaxFieldSize
	}
	if c.MaxRecordSize != 0 {
		r.MaxRecordSize = c.MaxRecordSize
	}
	r.KeepEmptyLines = r.KeepEmptyLines || c.KeepEmptyLines
	r.SkipEmptyLines = r.SkipEmptyLines || c.SkipEmptyLines
}

func (r *Reader) applyOptions(opts []Option) {
	if len(opts) == 0 {
		return
	}
	c := r.config()
	for _, opt := range opts {
		if opt != nil {
			opt(&c)
		}
	}
	r.Delimiter = c.Delimiter
	r.Quote = c.Quote
	r.CommentBytes = c.Comment
	r.Comment = c.CommentRune
	r.Comma = c.Comma
	r.QuoteRune = c.QuoteRune
	r.CommentRune = c.CommentRune
	r.LazyQuotes = c.LazyQuotes
	r.TrimLeadingSpace = c.TrimLeadingSpace
	r.FieldsPerRecord = c.FieldsPerRecord
	r.MaxFieldSize = c.MaxFieldSize
	r.MaxRecordSize = c.MaxRecordSize
	r.KeepEmptyLines = c.KeepEmptyLines
	r.SkipEmptyLines = c.SkipEmptyLines
}

func (r *Reader) config() Config {
	return Config{
		Delimiter:        r.Delimiter,
		Quote:            r.Quote,
		Comment:          r.CommentBytes,
		Comma:            r.Comma,
		QuoteRune:        r.QuoteRune,
		CommentRune:      r.Comment,
		LazyQuotes:       r.LazyQuotes,
		TrimLeadingSpace: r.TrimLeadingSpace,
		FieldsPerRecord:  r.FieldsPerRecord,
		MaxFieldSize:     r.MaxFieldSize,
		MaxRecordSize:    r.MaxRecordSize,
		KeepEmptyLines:   r.KeepEmptyLines,
		SkipEmptyLines:   r.SkipEmptyLines,
	}
}

func (r *Reader) init() error {
	if r.scan != nil || r.initErr != nil {
		return r.initErr
	}
	s, err := newScanner(r.config())
	if err != nil {
		r.initErr = err
		return err
	}
	r.scan = s
	return nil
}

func (r *Reader) fill() error {
	if r.fatalErr != nil {
		return r.fatalErr
	}
	if r.done {
		return io.EOF
	}
	if err := r.init(); err != nil {
		r.done = true
		r.fatalErr = err
		return err
	}

	emptyReads := 0
	for len(r.queue) == 0 && !r.done {
		n, err := r.src.Read(r.buf)
		if n > 0 {
			emptyReads = 0
			records, scanErr := r.scan.feed(r.buf[:n])
			r.queue = append(r.queue, records...)
			if scanErr != nil {
				r.done = true
				r.fatalErr = scanErr
			}
		} else if err == nil {
			emptyReads++
			if emptyReads >= 100 {
				r.done = true
				r.fatalErr = io.ErrNoProgress
			}
		}

		if err != nil {
			if errors.Is(err, io.EOF) {
				records, scanErr := r.scan.finish()
				r.queue = append(r.queue, records...)
				r.done = true
				if scanErr != nil {
					r.fatalErr = scanErr
				}
			} else {
				r.done = true
				r.fatalErr = err
			}
			break
		}
	}
	return r.fatalErr
}

// Read returns the next record. Parse errors are attached to Record.Err and
// are also returned, matching encoding/csv. Unlike a fatal reader error, a
// parse error does not poison the reader: the next call continues at the next
// physical record boundary.
func (r *Reader) Read() (*Record, error) {
	if len(r.queue) == 0 {
		if err := r.fill(); err != nil && len(r.queue) == 0 {
			return nil, err
		}
	}
	if len(r.queue) == 0 {
		return nil, io.EOF
	}
	rec := r.queue[0]
	r.queue = r.queue[1:]
	r.current = rec
	r.lastOffset = rec.nextOffset
	if rec.Err != nil {
		return rec, rec.Err
	}
	return rec, nil
}

// ReadRecord is an alias for Read.
func (r *Reader) ReadRecord() (*Record, error) { return r.Read() }

// Next advances to the next record. It returns false at EOF or on a fatal
// error. Record-local parse errors are available through Record.Err and do not
// stop iteration.
func (r *Reader) Next() bool {
	for len(r.queue) == 0 && !r.done {
		if err := r.fill(); err != nil && len(r.queue) == 0 {
			return false
		}
	}
	if len(r.queue) == 0 {
		return false
	}
	r.current = r.queue[0]
	r.queue = r.queue[1:]
	r.lastOffset = r.current.nextOffset
	return true
}

// Record returns the record returned by the last Next/Read call.
func (r *Reader) Record() *Record {
	return r.current
}

// Err returns the fatal reader/configuration error, if any. Recoverable parse
// errors are reported on Record.Err and are not returned here.
func (r *Reader) Err() error { return r.fatalErr }

// Close releases the reader. It does not close the underlying io.Reader.
func (r *Reader) Close() error {
	r.done = true
	return nil
}

// InputOffset returns the number of bytes consumed from the underlying reader
// so far.
func (r *Reader) InputOffset() int64 {
	return r.lastOffset
}

// Offset is an alias for InputOffset.
func (r *Reader) Offset() int64 { return r.InputOffset() }

// ReadAll reads all records. Recoverable record errors are retained in each
// Record.Err; the returned error is only a fatal I/O/configuration error.
func (r *Reader) ReadAll() ([]*Record, error) {
	var records []*Record
	for r.Next() {
		records = append(records, r.current)
	}
	if r.fatalErr != nil {
		return records, r.fatalErr
	}
	return records, nil
}

// ReadAllStrict stops at the first parse error and returns it with the records
// read so far.
func (r *Reader) ReadAllStrict() ([]*Record, error) {
	var records []*Record
	for {
		rec, err := r.Read()
		if err == io.EOF {
			return records, nil
		}
		if rec != nil {
			records = append(records, rec)
		}
		if err != nil {
			return records, err
		}
	}
}

// ReadFields reads one record and returns its structured fields.
func (r *Reader) ReadFields() ([]Field, error) {
	rec, err := r.Read()
	if rec == nil {
		return nil, err
	}
	return rec.Fields, err
}

// ReadStrings reads one record and returns decoded field values.
func (r *Reader) ReadStrings() ([]string, error) {
	rec, err := r.Read()
	if rec == nil {
		return nil, err
	}
	return rec.Values(), err
}

// ReadAllStrings reads all decoded records. Records with parse errors are
// omitted. Fatal errors are returned.
func (r *Reader) ReadAllStrings() ([][]string, error) {
	var out [][]string
	for r.Next() {
		if r.current.Err == nil {
			out = append(out, r.current.Values())
		}
	}
	return out, r.fatalErr
}

// Parser is the push/chunk oriented counterpart of Reader. Write may be
// called with arbitrary chunks; Feed additionally returns all records that
// became complete during the chunk. Flush emits the final record at EOF.
type Parser struct {
	Delimiter    []byte
	Quote        []byte
	Comment      rune
	CommentBytes []byte

	Comma       rune
	QuoteRune   rune
	CommentRune rune

	LazyQuotes       bool
	TrimLeadingSpace bool
	FieldsPerRecord  int
	MaxFieldSize     int
	MaxRecordSize    int
	KeepEmptyLines   bool
	SkipEmptyLines   bool

	scan     *scanner
	queue    []*Record
	current  *Record
	done     bool
	closed   bool
	initErr  error
	fatalErr error
}

// NewParser creates a push parser with the same option handling as NewReader.
func NewParser(args ...any) *Parser {
	p := &Parser{Comma: ','}
	var opts []Option
	for _, arg := range args {
		switch v := arg.(type) {
		case nil:
		case string:
			opts = append(opts, WithDelimiter(v))
		case []byte:
			opts = append(opts, WithDelimiter(v))
		case byte:
			opts = append(opts, WithDelimiter(v))
		case rune:
			opts = append(opts, WithDelimiter(v))
		case Config:
			p.applyConfig(v)
		case *Config:
			if v != nil {
				p.applyConfig(*v)
			}
		case Option:
			opts = append(opts, v)
		}
	}
	if len(opts) != 0 {
		c := p.config()
		for _, opt := range opts {
			if opt != nil {
				opt(&c)
			}
		}
		p.applyConfig(c)
	}
	return p
}

func (p *Parser) applyConfig(c Config) {
	if c.Delimiter != nil {
		p.Delimiter = append([]byte(nil), c.Delimiter...)
	}
	if c.Quote != nil {
		p.Quote = append([]byte(nil), c.Quote...)
	}
	if c.Comment != nil {
		p.CommentBytes = append([]byte(nil), c.Comment...)
	}
	if c.Comma != 0 {
		p.Comma = c.Comma
	}
	if c.QuoteRune != 0 {
		p.QuoteRune = c.QuoteRune
	}
	if c.CommentRune != 0 {
		p.Comment = c.CommentRune
		p.CommentRune = c.CommentRune
	}
	p.LazyQuotes = p.LazyQuotes || c.LazyQuotes
	p.TrimLeadingSpace = p.TrimLeadingSpace || c.TrimLeadingSpace
	if c.FieldsPerRecord != 0 {
		p.FieldsPerRecord = c.FieldsPerRecord
	}
	if c.MaxFieldSize != 0 {
		p.MaxFieldSize = c.MaxFieldSize
	}
	if c.MaxRecordSize != 0 {
		p.MaxRecordSize = c.MaxRecordSize
	}
	p.KeepEmptyLines = p.KeepEmptyLines || c.KeepEmptyLines
	p.SkipEmptyLines = p.SkipEmptyLines || c.SkipEmptyLines
}

func (p *Parser) config() Config {
	return Config{
		Delimiter:        p.Delimiter,
		Quote:            p.Quote,
		Comment:          p.CommentBytes,
		Comma:            p.Comma,
		QuoteRune:        p.QuoteRune,
		CommentRune:      p.Comment,
		LazyQuotes:       p.LazyQuotes,
		TrimLeadingSpace: p.TrimLeadingSpace,
		FieldsPerRecord:  p.FieldsPerRecord,
		MaxFieldSize:     p.MaxFieldSize,
		MaxRecordSize:    p.MaxRecordSize,
		KeepEmptyLines:   p.KeepEmptyLines,
		SkipEmptyLines:   p.SkipEmptyLines,
	}
}

func (p *Parser) init() error {
	if p.scan != nil || p.initErr != nil {
		return p.initErr
	}
	s, err := newScanner(p.config())
	if err != nil {
		p.initErr = err
		return err
	}
	p.scan = s
	return nil
}

// Write implements io.Writer. Records completed by this chunk are queued and
// can be obtained with Next/Record or the next Feed/Flush call.
func (p *Parser) Write(chunk []byte) (int, error) {
	if p.closed {
		return 0, io.ErrClosedPipe
	}
	if err := p.init(); err != nil {
		p.fatalErr = err
		return 0, err
	}
	records, err := p.scan.feed(chunk)
	p.queue = append(p.queue, records...)
	if err != nil {
		p.fatalErr = err
	}
	return len(chunk), err
}

// WriteString is a convenience wrapper around Write.
func (p *Parser) WriteString(chunk string) (int, error) {
	return p.Write([]byte(chunk))
}

// Feed writes one chunk and immediately returns the records completed by it.
func (p *Parser) Feed(chunk []byte) ([]*Record, error) {
	if _, err := p.Write(chunk); err != nil {
		return p.drain(), err
	}
	return p.drain(), nil
}

// Push is an alias for Feed.
func (p *Parser) Push(chunk []byte) ([]*Record, error) { return p.Feed(chunk) }

// Flush finalizes the stream and returns any remaining records.
func (p *Parser) Flush() ([]*Record, error) {
	if p.closed {
		return p.drain(), nil
	}
	p.closed = true
	if err := p.init(); err != nil {
		p.fatalErr = err
		return p.drain(), err
	}
	records, err := p.scan.finish()
	p.queue = append(p.queue, records...)
	if err != nil {
		p.fatalErr = err
	}
	return p.drain(), err
}

// Close flushes the stream. Remaining records stay available through Next.
func (p *Parser) Close() error {
	_, err := p.Flush()
	return err
}

func (p *Parser) drain() []*Record {
	out := p.queue
	p.queue = nil
	return out
}

// Next advances to the next queued record. It returns false when no complete
// record is currently available.
func (p *Parser) Next() bool {
	if len(p.queue) == 0 {
		return false
	}
	p.current = p.queue[0]
	p.queue = p.queue[1:]
	return true
}

// Record returns the record returned by the last Next call.
func (p *Parser) Record() *Record { return p.current }

// Err returns the fatal parser error, if any.
func (p *Parser) Err() error { return p.fatalErr }

// Parse parses an entire byte slice. It is exactly equivalent to feeding the
// same bytes through a Parser in one chunk, and to feeding them in any number
// of chunks followed by Flush.
func Parse(data []byte, args ...any) ([]*Record, error) {
	p := NewParser(args...)
	records, err := p.Feed(data)
	tail, ferr := p.Flush()
	records = append(records, tail...)
	if err != nil {
		return records, err
	}
	return records, ferr
}

// ParseString is a string convenience wrapper around Parse.
func ParseString(data string, args ...any) ([]*Record, error) {
	return Parse([]byte(data), args...)
}

// ParseChunks parses chunks in order. This helper exists mainly for callers
// that already have chunk boundaries; the result is independent of how the
// same bytes are split.
func ParseChunks(chunks [][]byte, args ...any) ([]*Record, error) {
	p := NewParser(args...)
	var records []*Record
	for _, chunk := range chunks {
		recs, err := p.Feed(chunk)
		records = append(records, recs...)
		if err != nil {
			return records, err
		}
	}
	tail, err := p.Flush()
	records = append(records, tail...)
	return records, err
}

// ReadAll is a one-shot convenience function.
func ReadAll(src io.Reader, args ...any) ([]*Record, error) {
	all := make([]any, 0, len(args)+1)
	all = append(all, src)
	all = append(all, args...)
	return NewReader(all...).ReadAll()
}
