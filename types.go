package dataeng

import (
	"errors"
	"fmt"
	"strings"
)

// Errors reported by the reader. They are intentionally named like the
// errors in encoding/csv, while being independent values so callers can use
// errors.Is without depending on a particular Go release.
var (
	ErrBareQuote        = errors.New("bare \" in non-quoted-field")
	ErrQuote            = errors.New(`extraneous or missing " in quoted-field`)
	ErrFieldCount       = errors.New("wrong number of fields")
	ErrFieldTooLarge    = errors.New("field exceeds configured size limit")
	ErrRecordTooLarge   = errors.New("record exceeds configured size limit")
	ErrInvalidDelimiter = errors.New("invalid delimiter")
)

// ParseError describes a recoverable error in one physical record. Offset is
// the absolute byte offset in the input stream. Line and Column are 1-based.
type ParseError struct {
	StartLine int
	Line      int
	Column    int
	Offset    int64
	Field     int
	Err       error
}

func (e *ParseError) Error() string {
	if e == nil {
		return "<nil>"
	}
	line := e.Line
	if line == 0 {
		line = e.StartLine
	}
	if e.Err == nil {
		return fmt.Sprintf("csv: line %d, column %d", line, e.Column)
	}
	return fmt.Sprintf("csv: line %d, column %d: %v", line, e.Column, e.Err)
}

// Unwrap makes errors.Is(err, ErrQuote) work for parse errors.
func (e *ParseError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

// Config controls parsing. The zero value uses a comma delimiter, a double
// quote, LF/CRLF line endings, and skips blank physical lines.
//
// Delimiter may contain any number of bytes except CR and LF. When Delimiter
// is nil, Comma (or ',' when Comma is zero) is used. Quote is the quote token;
// when nil, QuoteRune (or '"' when both are zero) is used.
type Config struct {
	Delimiter []byte
	Quote     []byte
	Comment   []byte

	// Comma, QuoteRune and CommentRune are convenience aliases compatible
	// with the configuration style of encoding/csv.
	Comma       rune
	QuoteRune   rune
	CommentRune rune

	LazyQuotes       bool
	TrimLeadingSpace bool
	FieldsPerRecord  int

	// MaxFieldSize limits the raw size of one field. Zero means unlimited.
	// Exceeding it reports ErrFieldTooLarge for that record and continues with
	// subsequent records.
	MaxFieldSize int

	// MaxRecordSize limits the number of bytes retained for one record. Zero
	// means unlimited. When the limit is reached the current record is
	// discarded, but scanning continues to the next reliable physical record
	// boundary so later records are still delivered.
	MaxRecordSize int

	// KeepEmptyLines makes blank physical lines visible as records containing
	// one empty field. By default they are skipped, matching encoding/csv.
	KeepEmptyLines bool

	// SkipEmptyLines is the inverse spelling of KeepEmptyLines. It is useful
	// in configuration literals; when true it wins over KeepEmptyLines.
	SkipEmptyLines bool
}

// Option configures a Reader, Parser or one-shot Parse call.
type Option func(*Config)

// WithDelimiter sets the delimiter. v may be a string, []byte, byte or rune.
func WithDelimiter(v any) Option {
	return func(c *Config) {
		if b, ok := bytesValue(v); ok {
			c.Delimiter = b
		}
	}
}

// WithComma is an alias for WithDelimiter.
func WithComma(v any) Option { return WithDelimiter(v) }

// WithQuote sets the quote token. v may be a string, []byte, byte or rune.
func WithQuote(v any) Option {
	return func(c *Config) {
		if b, ok := bytesValue(v); ok {
			c.Quote = b
		}
	}
}

// WithComment sets the comment prefix for physical lines at record start.
func WithComment(v any) Option {
	return func(c *Config) {
		if b, ok := bytesValue(v); ok {
			c.Comment = b
		}
	}
}

func WithLazyQuotes(v bool) Option       { return func(c *Config) { c.LazyQuotes = v } }
func WithTrimLeadingSpace(v bool) Option { return func(c *Config) { c.TrimLeadingSpace = v } }
func WithFieldsPerRecord(n int) Option   { return func(c *Config) { c.FieldsPerRecord = n } }
func WithMaxFieldSize(n int) Option      { return func(c *Config) { c.MaxFieldSize = n } }
func WithMaxRecordSize(n int) Option     { return func(c *Config) { c.MaxRecordSize = n } }
func WithKeepEmptyLines(v bool) Option   { return func(c *Config) { c.KeepEmptyLines = v } }
func WithSkipEmptyLines(v bool) Option   { return func(c *Config) { c.SkipEmptyLines = v } }

func bytesValue(v any) ([]byte, bool) {
	switch x := v.(type) {
	case nil:
		return nil, false
	case string:
		return []byte(x), true
	case []byte:
		return append([]byte(nil), x...), true
	case byte:
		return []byte{x}, true
	case rune:
		return []byte(string(x)), true
	case int:
		return []byte(string(rune(x))), true
	default:
		return nil, false
	}
}

// Field is one parsed field. Start and End are absolute, half-open byte
// offsets into the input stream. For a quoted field the raw interval includes
// the surrounding quote tokens; ContentStart and ContentEnd delimit the bytes
// between them. Raw and Value are independent copies and remain valid after
// the next read.
//
// Value contains the decoded field content (outer quotes removed and doubled
// quotes collapsed). Raw contains the field exactly as it appeared in input.
type Field struct {
	Start        int64
	End          int64
	ContentStart int64
	ContentEnd   int64
	Raw          []byte
	Value        []byte
	Quoted       bool
	Index        int
}

// Text returns Value as a string.
func (f Field) Text() string { return string(f.Value) }

// String implements fmt.Stringer.
func (f Field) String() string { return f.Text() }

// Bounds returns the absolute raw byte interval of the field.
func (f Field) Bounds() (start, end int64) { return f.Start, f.End }

// ContentBounds returns the absolute byte interval between the quote tokens
// (or the whole field for an unquoted field).
func (f Field) ContentBounds() (start, end int64) { return f.ContentStart, f.ContentEnd }

// Record is one logical record. Start and End are absolute, half-open byte
// offsets and exclude the record terminator. Fields are in input order.
type Record struct {
	Start   int64
	End     int64
	Line    int
	EndLine int
	Fields  []Field
	Raw     []byte
	Err     error

	nextOffset int64
}

// Values returns the decoded field values as strings.
func (r Record) Values() []string {
	if len(r.Fields) == 0 {
		return nil
	}
	out := make([]string, len(r.Fields))
	for i := range r.Fields {
		out[i] = string(r.Fields[i].Value)
	}
	return out
}

// Strings is an alias for Values.
func (r Record) Strings() []string { return r.Values() }

// Field returns field i, or a zero Field when i is out of range.
func (r Record) Field(i int) Field {
	if i < 0 || i >= len(r.Fields) {
		return Field{}
	}
	return r.Fields[i]
}

func (r Record) String() string {
	values := r.Values()
	for i := range values {
		if strings.ContainsAny(values[i], ",\"\r\n") {
			values[i] = `"` + strings.ReplaceAll(values[i], `"`, `""`) + `"`
		}
	}
	return strings.Join(values, ",")
}

// Sanitized returns a copy of c with defaults expanded.
func (c Config) Sanitized() Config {
	out := c
	if len(out.Delimiter) == 0 {
		if out.Comma != 0 {
			out.Delimiter = []byte(string(out.Comma))
		} else {
			out.Delimiter = []byte{','}
		}
	} else {
		out.Delimiter = append([]byte(nil), out.Delimiter...)
	}
	if len(out.Quote) == 0 {
		if out.QuoteRune != 0 {
			out.Quote = []byte(string(out.QuoteRune))
		} else {
			out.Quote = []byte{'"'}
		}
	} else {
		out.Quote = append([]byte(nil), out.Quote...)
	}
	if len(out.Comment) == 0 && out.CommentRune != 0 {
		out.Comment = []byte(string(out.CommentRune))
	} else if len(out.Comment) != 0 {
		out.Comment = append([]byte(nil), out.Comment...)
	}
	return out
}

func (c Config) validate() error {
	if len(c.Delimiter) == 0 {
		return fmt.Errorf("%w: empty delimiter", ErrInvalidDelimiter)
	}
	if containsByte(c.Delimiter, '\n') || containsByte(c.Delimiter, '\r') {
		return fmt.Errorf("%w: delimiter contains a newline", ErrInvalidDelimiter)
	}
	if len(c.Quote) == 0 {
		return fmt.Errorf("%w: empty quote", ErrInvalidDelimiter)
	}
	if containsByte(c.Quote, '\n') || containsByte(c.Quote, '\r') {
		return fmt.Errorf("%w: quote contains a newline", ErrInvalidDelimiter)
	}
	if bytesEqual(c.Delimiter, c.Quote) ||
		hasPrefix(c.Delimiter, c.Quote) || hasPrefix(c.Quote, c.Delimiter) {
		return fmt.Errorf("%w: delimiter and quote overlap", ErrInvalidDelimiter)
	}
	for i := 0; i < len(c.Delimiter); i++ {
		if containsByte(c.Quote, c.Delimiter[i]) {
			return fmt.Errorf("%w: delimiter contains a quote byte", ErrInvalidDelimiter)
		}
	}
	if len(c.Comment) != 0 {
		if hasPrefix(c.Comment, c.Quote) || hasPrefix(c.Quote, c.Comment) {
			return fmt.Errorf("%w: comment and quote overlap", ErrInvalidDelimiter)
		}
		if hasPrefix(c.Comment, c.Delimiter) || hasPrefix(c.Delimiter, c.Comment) {
			return fmt.Errorf("%w: comment and delimiter overlap", ErrInvalidDelimiter)
		}
	}
	return nil
}

func containsByte(b []byte, x byte) bool {
	for _, c := range b {
		if c == x {
			return true
		}
	}
	return false
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func hasPrefix(b, prefix []byte) bool {
	return len(b) >= len(prefix) && bytesEqual(b[:len(prefix)], prefix)
}
