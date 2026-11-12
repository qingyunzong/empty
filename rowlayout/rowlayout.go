// Package rowlayout encodes and decodes fixed-schema binary rows consumed by
// the line-oriented data ingestion host.
//
// One line has the layout
//
//	validity bitmap | non-null field payloads | zero padding
//
// The bitmap occupies ceil(field count/8) bytes. Bit i, counting from the
// low-order bit of byte zero, marks schema field i as non-null. Only
// non-null fields are written, in schema order: int64 as eight little-endian
// two's-complement bytes, bool as a single 0/1 byte, and byte strings as a
// four-byte little-endian length followed by the raw body. The line ends with
// zero padding up to a multiple of eight bytes, so a field's offset always
// depends on which earlier fields are present and never on its field number.
package rowlayout

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// FieldType selects the on-wire encoding of a schema field.
type FieldType uint8

const (
	// Int64 encodes as eight little-endian two's-complement bytes.
	Int64 FieldType = iota + 1
	// Bool encodes as one byte holding 0 or 1.
	Bool
	// Bytes encodes as a four-byte little-endian length and the raw body.
	Bytes
)

// Field is one ordered, nullable schema column.
type Field struct {
	Name string
	Type FieldType
}

// Schema is an ordered, immutable collection of fields.
type Schema struct {
	fields []Field
}

// NewSchema copies fields and validates every field type.
func NewSchema(fields []Field) (*Schema, error) {
	for i, field := range fields {
		switch field.Type {
		case Int64, Bool, Bytes:
		default:
			return nil, fmt.Errorf("%w: field %d (%q) has unknown type %d",
				ErrInvalidSchema, i, field.Name, field.Type)
		}
	}
	return &Schema{fields: append([]Field(nil), fields...)}, nil
}

// Len returns the number of schema fields.
func (s *Schema) Len() int { return len(s.fields) }

// Field returns the field at index i.
func (s *Schema) Field(i int) Field { return s.fields[i] }

// Fields returns a copy of the schema fields.
func (s *Schema) Fields() []Field { return append([]Field(nil), s.fields...) }

// Value carries one field value. Null is explicit: a non-null Value with a nil
// Bytes slice encodes an empty byte string, not SQL-style NULL.
type Value struct {
	Null  bool
	Int   int64
	Bool  bool
	Bytes []byte
}

// Range is the half-open [Start, End) byte span of a field inside the decoded
// line, including the four-byte length prefix of byte strings. Null fields
// carry Null=true with Start and End set to zero.
type Range struct {
	Null  bool
	Start int
	End   int
}

// Row is the decoded result: Values and Ranges are indexed by schema field.
type Row struct {
	Values []Value
	Ranges []Range
}

// Sentinel errors returned by Decode and Encode; wrap with errors.Is.
var (
	ErrEmptyLine        = errors.New("rowlayout: empty line")
	ErrLineTooLong      = errors.New("rowlayout: line exceeds maximum length")
	ErrTruncated        = errors.New("rowlayout: truncated line")
	ErrInvalidBitmap    = errors.New("rowlayout: unused bitmap bits must be zero")
	ErrInvalidBool      = errors.New("rowlayout: bool field must encode as 0 or 1")
	ErrLengthOutOfRange = errors.New("rowlayout: byte string length out of range")
	ErrNonZeroPadding   = errors.New("rowlayout: padding bytes must be zero")
	ErrTrailingBytes    = errors.New("rowlayout: trailing bytes after row payload")
	ErrInvalidSchema    = errors.New("rowlayout: invalid schema")
	ErrInvalidValue     = errors.New("rowlayout: invalid encode value")
)

// Encode writes one complete line. Values must contain exactly one entry per
// schema field, in schema order.
func Encode(schema *Schema, values []Value) ([]byte, error) {
	if schema == nil {
		return nil, fmt.Errorf("%w: nil schema", ErrInvalidSchema)
	}
	fieldCount := schema.Len()
	if len(values) != fieldCount {
		return nil, fmt.Errorf("%w: got %d values for a %d-field schema",
			ErrInvalidValue, len(values), fieldCount)
	}

	bitmapLen := (fieldCount + 7) / 8
	bitmap := make([]byte, bitmapLen)
	payload := make([]byte, 0, fieldCount*8)

	for i, field := range schema.fields {
		value := values[i]
		if value.Null {
			continue
		}
		bitmap[i/8] |= 1 << (uint(i) % 8)

		switch field.Type {
		case Int64:
			var encoded [8]byte
			binary.LittleEndian.PutUint64(encoded[:], uint64(value.Int))
			payload = append(payload, encoded[:]...)
		case Bool:
			if value.Bool {
				payload = append(payload, 1)
			} else {
				payload = append(payload, 0)
			}
		case Bytes:
			if len(value.Bytes) > math.MaxUint32 {
				return nil, fmt.Errorf("%w: field %q byte string length %d exceeds uint32",
					ErrInvalidValue, field.Name, len(value.Bytes))
			}
			var length [4]byte
			binary.LittleEndian.PutUint32(length[:], uint32(len(value.Bytes)))
			payload = append(payload, length[:]...)
			payload = append(payload, value.Bytes...)
		}
	}

	line := make([]byte, bitmapLen+len(payload))
	copy(line[:bitmapLen], bitmap)
	copy(line[bitmapLen:], payload)
	if pad := len(line) % 8; pad != 0 {
		line = append(line, make([]byte, 8-pad)...)
	}
	return line, nil
}

// Decode parses one complete line that is no longer than maxLineLen. It rejects
// non-zero padding, set unused bitmap bits, out-of-range byte string lengths,
// and any trailing bytes, and reports each field's original byte range.
func Decode(schema *Schema, line []byte, maxLineLen int) (*Row, error) {
	if schema == nil {
		return nil, fmt.Errorf("%w: nil schema", ErrInvalidSchema)
	}
	fieldCount := schema.Len()
	if len(line) == 0 {
		if fieldCount == 0 {
			return &Row{Values: []Value{}, Ranges: []Range{}}, nil
		}
		return nil, ErrEmptyLine
	}
	if maxLineLen < 0 || len(line) > maxLineLen {
		return nil, fmt.Errorf("%w: line length %d exceeds %d",
			ErrLineTooLong, len(line), maxLineLen)
	}

	bitmapLen := (fieldCount + 7) / 8
	if len(line) < bitmapLen {
		return nil, fmt.Errorf("%w: %d-byte line cannot hold %d-byte bitmap",
			ErrTruncated, len(line), bitmapLen)
	}
	if usedBits := fieldCount % 8; usedBits != 0 {
		unusedMask := byte(0xff) << usedBits
		if line[bitmapLen-1]&unusedMask != 0 {
			return nil, ErrInvalidBitmap
		}
	}

	row := &Row{
		Values: make([]Value, fieldCount),
		Ranges: make([]Range, fieldCount),
	}

	pos := bitmapLen
	for i, field := range schema.fields {
		if line[i/8]&(1<<(uint(i)%8)) == 0 {
			row.Values[i] = Value{Null: true}
			row.Ranges[i] = Range{Null: true}
			continue
		}

		start := pos
		switch field.Type {
		case Int64:
			if pos+8 > len(line) {
				return nil, fmt.Errorf("%w: field %q int64", ErrTruncated, field.Name)
			}
			row.Values[i] = Value{
				Int: int64(binary.LittleEndian.Uint64(line[pos : pos+8])),
			}
			pos += 8
		case Bool:
			if pos+1 > len(line) {
				return nil, fmt.Errorf("%w: field %q bool", ErrTruncated, field.Name)
			}
			switch line[pos] {
			case 0:
			case 1:
				row.Values[i].Bool = true
			default:
				return nil, fmt.Errorf("%w: field %q got byte %d",
					ErrInvalidBool, field.Name, line[pos])
			}
			pos++
		case Bytes:
			if pos+4 > len(line) {
				return nil, fmt.Errorf("%w: field %q length prefix", ErrTruncated, field.Name)
			}
			bodyLen := uint64(binary.LittleEndian.Uint32(line[pos : pos+4]))
			end := uint64(pos) + 4 + bodyLen
			if end > uint64(len(line)) {
				return nil, fmt.Errorf("%w: field %q claims %d body bytes in a %d-byte line",
					ErrLengthOutOfRange, field.Name, bodyLen, len(line))
			}
			row.Values[i] = Value{
				Bytes: append([]byte(nil), line[pos+4:end]...),
			}
			pos = int(end)
		}
		row.Ranges[i] = Range{Start: start, End: pos}
	}

	pad := (8 - pos%8) % 8
	if expectedLen := pos + pad; len(line) != expectedLen {
		return nil, fmt.Errorf("%w: line is %d bytes but payload ends at %d",
			ErrTrailingBytes, len(line), pos)
	}
	for _, paddingByte := range line[pos:] {
		if paddingByte != 0 {
			return nil, ErrNonZeroPadding
		}
	}
	return row, nil
}
