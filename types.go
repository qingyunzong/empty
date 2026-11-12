package dataeng

import (
	"errors"
	"fmt"
)

// ValueKind is the restricted set of record values supported by this package.
// It intentionally does not model the other SQLite serial types.
type ValueKind uint8

const (
	// ValueNull is serial type 0.
	ValueNull ValueKind = iota + 1
	// ValueInteger is serial type 6, an 8-byte big-endian int64.
	ValueInteger
	// ValueBlob is an even serial type >= 12.
	ValueBlob
)

func (k ValueKind) String() string {
	switch k {
	case ValueNull:
		return "null"
	case ValueInteger:
		return "integer"
	case ValueBlob:
		return "blob"
	default:
		return fmt.Sprintf("ValueKind(%d)", uint8(k))
	}
}

// SpanLocation identifies whether a payload interval lives in the target
// cell's local bytes or in an overflow page.
type SpanLocation uint8

const (
	// SpanCell is the cell's local payload area.
	SpanCell SpanLocation = iota + 1
	// SpanOverflow is an overflow page payload area, after its 4-byte link.
	SpanOverflow
)

// ReadPurpose identifies why a ReaderAt request was made.
type ReadPurpose uint8

const (
	// ReadCellVarint reads the payload-length or rowid varint in the cell.
	ReadCellVarint ReadPurpose = iota + 1
	// ReadOverflowLink reads the 4-byte next-page link of an overflow page.
	ReadOverflowLink
	// ReadRecordHeader reads bytes belonging to the record header.
	ReadRecordHeader
	// ReadProjectedValue reads bytes belonging to a requested column value.
	ReadProjectedValue
)

func (p ReadPurpose) String() string {
	switch p {
	case ReadCellVarint:
		return "cell-varint"
	case ReadOverflowLink:
		return "overflow-link"
	case ReadRecordHeader:
		return "record-header"
	case ReadProjectedValue:
		return "projected-value"
	default:
		return fmt.Sprintf("ReadPurpose(%d)", uint8(p))
	}
}

// ReadEvent is one actual ReaderAt request issued by the package. Segments
// below separately describe the logical-to-physical mapping of returned values.
type ReadEvent struct {
	Page          uint64
	PageOffset    int
	FileOffset    int64
	Length        int
	Purpose       ReadPurpose
	Location      SpanLocation
	LogicalOffset uint64
	LogicalLength uint64
}

// Segment maps a payload-relative logical interval to one physical page.
// LogicalOffset is relative to the start of the complete logical payload,
// not relative to the individual column value.
type Segment struct {
	Page          uint64
	PageOffset    uint64
	LogicalOffset uint64
	Length        uint64
	Location      SpanLocation
}

// OverflowPage describes the payload bytes consumed from one overflow page.
// Length is only the number of bytes that belong to the record; unused tail
// bytes in the final page are deliberately not included.
type OverflowPage struct {
	Page          uint64
	PageOffset    uint64
	LogicalOffset uint64
	Length        uint64
}

// ColumnValue is one projected column occurrence. Duplicate projection
// indices produce separate ColumnValue entries in the requested order.
//
// A null value has Kind ValueNull and a nil Blob. An empty blob has Kind
// ValueBlob, a non-nil zero-length Blob, and no byte segments.
type ColumnValue struct {
	ColumnIndex   int
	Kind          ValueKind
	Integer       int64
	Blob          []byte
	LogicalOffset uint64
	Length        uint64
	Segments      []Segment
}

// Result contains a successfully validated and projected target cell.
//
// Blob values are fresh copies. They do not alias the ReaderAt, page buffers,
// or other returned occurrences. Segments describe where the value bytes were
// read from. Reads records every actual ReaderAt request made while building
// this result.
type Result struct {
	RowID             int64
	PayloadLength     uint64
	LocalLength       uint64
	CellPage          uint64
	CellOffset        int
	CellLength        int
	FirstOverflowPage uint64
	OverflowPages     []OverflowPage
	Columns           []ColumnValue
	Reads             []ReadEvent
}

// Error carries a stable error category plus the ReaderAt requests made
// before a failure. errors.Is works against the exported Err* values.
type Error struct {
	Cause  error
	Detail string
	Reads  []ReadEvent
}

func (e *Error) Error() string {
	if e.Detail == "" {
		return e.Cause.Error()
	}
	return e.Cause.Error() + ": " + e.Detail
}

func (e *Error) Unwrap() error {
	return e.Cause
}

var (
	ErrInvalidConfig      = errors.New("dataeng: invalid configuration")
	ErrInvalidCell        = errors.New("dataeng: invalid cell reference")
	ErrCellLengthMismatch = errors.New("dataeng: cell length does not match its components")
	ErrShortRead          = errors.New("dataeng: short ReaderAt read")
	ErrPayloadOutOfRange  = errors.New("dataeng: logical payload range is out of bounds")
	ErrOverflowOutOfRange = errors.New("dataeng: overflow page is out of range")
	ErrOverflowChainCycle = errors.New("dataeng: overflow chain cycles or returns to the cell page")
	ErrOverflowChainEarly = errors.New("dataeng: overflow chain ends before covering the payload")
	ErrOverflowChainExtra = errors.New("dataeng: overflow chain has an extra page")
	ErrBudgetExceeded     = errors.New("dataeng: budget exceeded")
	ErrHeaderInvalid      = errors.New("dataeng: invalid record header")
	ErrUnsupportedSerial  = errors.New("dataeng: unsupported serial type")
	// ErrUnsupportedSerialType is an alias of ErrUnsupportedSerial.
	ErrUnsupportedSerialType = ErrUnsupportedSerial
	ErrProjectionOutOfRange  = errors.New("dataeng: projection index is out of range")
	ErrRecordLengthMismatch  = errors.New("dataeng: record header and body lengths do not match")
	ErrVarintTruncated       = errors.New("dataeng: varint is truncated")
)
