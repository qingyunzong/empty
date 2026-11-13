package dataeng

// Compatibility aliases. Reader is the streaming io.Reader-based parser and
// Parser is the push/chunk-based parser.
type (
	CSVReader    = Reader
	StreamReader = Reader
	CSVParser    = Parser
	StreamParser = Parser
	ChunkParser  = Parser
	FieldSpan    = Field
	CSVRecord    = Record
)

// NewCSVReader is an alias for NewReader.
func NewCSVReader(args ...any) *Reader { return NewReader(args...) }

// NewStreamReader is an alias for NewReader.
func NewStreamReader(args ...any) *Reader { return NewReader(args...) }

// NewCSVParser is an alias for NewParser.
func NewCSVParser(args ...any) *Parser { return NewParser(args...) }

// NewChunkParser is an alias for NewParser.
func NewChunkParser(args ...any) *Parser { return NewParser(args...) }

// StartOffset returns the absolute first byte of the field.
func (f Field) StartOffset() int64 { return f.Start }

// EndOffset returns the absolute byte just past the field.
func (f Field) EndOffset() int64 { return f.End }

// Bytes returns the raw field bytes.
func (f Field) Bytes() []byte { return f.Raw }

// Decoded returns the decoded field value.
func (f Field) Decoded() []byte { return f.Value }

// StartOffset returns the absolute first byte of the record.
func (r Record) StartOffset() int64 { return r.Start }

// EndOffset returns the absolute byte just past the record body.
func (r Record) EndOffset() int64 { return r.End }

// Scan is an alias for Next.
func (r *Reader) Scan() bool { return r.Next() }

// Scan is an alias for Next.
func (p *Parser) Scan() bool { return p.Next() }
