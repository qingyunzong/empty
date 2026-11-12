package dataeng

// KeyType identifies the concrete Go type used for a row's key column.
//
// The caller chooses one key type for an index and all keys in the index and
// the rows scanned with it must use that type. A nil key is always accepted
// and represents SQL NULL.
type KeyType uint8

const (
	KeyTypeInvalid KeyType = iota
	KeyTypeInt64
	KeyTypeString
)

// Aliases for callers that prefer the type name before the Go type name.
const (
	Int64Key  = KeyTypeInt64
	StringKey = KeyTypeString
)

// Valid reports whether t is a supported key type.
func (t KeyType) Valid() bool {
	return t == KeyTypeInt64 || t == KeyTypeString
}

func (t KeyType) String() string {
	switch t {
	case KeyTypeInt64:
		return "int64"
	case KeyTypeString:
		return "string"
	default:
		return "invalid"
	}
}

// DeleteKind identifies how a delete record matches data rows.
type DeleteKind uint8

const (
	DeleteKindInvalid DeleteKind = iota

	// PositionDeleteKind matches a data file ID and row number. Position deletes
	// do not use the row's key or data sequence number.
	PositionDeleteKind

	// EqualityDeleteKind matches a key by value and applies only when the
	// delete's sequence number is strictly greater than the row's data
	// sequence number.
	EqualityDeleteKind
)

const (
	PositionDelete = PositionDeleteKind
	EqualityDelete = EqualityDeleteKind
)

// DataRow is one row produced by a data file reader.
type DataRow struct {
	FileID             string
	RowNumber          int64
	Key                any
	DataSequenceNumber int64
}

// Delete is one record read from a delete file.
//
// Kind determines which fields are used:
//
//   - PositionDeleteKind uses DataFileID and RowNumber.
//   - EqualityDeleteKind uses Key.
//
// DeleteFileID and SequenceNumber identify the delete itself and are used for
// evidence reporting and tie-breaking.
type Delete struct {
	Kind           DeleteKind
	DeleteFileID   string
	SequenceNumber int64

	// DataFileID and RowNumber identify the target of a position delete.
	DataFileID string
	RowNumber  int64

	// Key is the value matched by an equality delete. It may be nil (NULL) or
	// the concrete type selected by the index's key type.
	Key any
}

// DeleteEvidence describes the first delete that applies to a row.
type DeleteEvidence struct {
	Kind           DeleteKind
	DeleteFileID   string
	SequenceNumber int64

	DataFileID string
	RowNumber  int64
	Key        any
}

// RowVisibility is the result for one data row.
type RowVisibility struct {
	Deleted  bool
	Evidence *DeleteEvidence
}

// Visible reports whether the row survived all deletes.
func (v RowVisibility) Visible() bool {
	return !v.Deleted
}

// NewPositionDelete builds a position delete record.
func NewPositionDelete(deleteFileID string, sequenceNumber int64, dataFileID string, rowNumber int64) Delete {
	return Delete{
		Kind:           PositionDeleteKind,
		DeleteFileID:   deleteFileID,
		SequenceNumber: sequenceNumber,
		DataFileID:     dataFileID,
		RowNumber:      rowNumber,
	}
}

// NewEqualityDelete builds an equality delete record.
func NewEqualityDelete(deleteFileID string, sequenceNumber int64, key any) Delete {
	return Delete{
		Kind:           EqualityDeleteKind,
		DeleteFileID:   deleteFileID,
		SequenceNumber: sequenceNumber,
		Key:            key,
	}
}
