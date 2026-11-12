// Package qpackdec implements the post-parse portion of a QPACK decoder for
// an HTTP/3 collector.
//
// The host is responsible for parsing QPACK wire bytes, including integer and
// Huffman encoding. This package deliberately contains no byte-level
// decoding. It accepts structured events and implements:
//
//   - the dynamic table with absolute, monotonically increasing indices and
//     oldest-first eviction on insertion and capacity shrink,
//   - required-insert-count recovery with full-range wrap around,
//   - base computation with signed delta handling,
//   - cross-stream blocking: header blocks that reference not-yet-inserted
//     entries are frozen at reception and replayed in reception order once
//     the required insert count is reached,
//   - stream cancellation, duplicate-id rejection and blocked-stream limits,
//   - ordered, fully validated field delivery with absolute-index provenance.
//
// Every count is an exact int64 with checked arithmetic so that no counter can
// silently wrap. Any decoding error is terminal: the component retains the
// error evidence, stops processing, and rejects every further operation.
//
// A Decoder is not safe for concurrent use.
package qpackdec

// FieldSource identifies how a delivered field line was produced.
type FieldSource int

const (
	// SourceLiteral is a field supplied verbatim in the header block.
	SourceLiteral FieldSource = iota
	// SourceStatic references the static table supplied at construction.
	SourceStatic
	// SourceDynamic references a dynamic-table entry by absolute index.
	SourceDynamic
)

// StaticField is one zero-based static-table entry supplied by the host.
type StaticField struct {
	Name  string
	Value string
}

// FieldKind selects the encoding of one field line inside a header block.
type FieldKind int

const (
	// FieldLiteral carries an explicit name and value.
	FieldLiteral FieldKind = iota
	// FieldStatic references a static-table entry; Index is the static index.
	FieldStatic
	// FieldRelative is a relative dynamic reference; Index is i in Base-i-1.
	FieldRelative
	// FieldPostBase is a post-base dynamic reference; Index is i in Base+i.
	FieldPostBase
)

// Field is one abstract field line. Name and Value are used only for
// FieldLiteral; Index is used for the three indexed kinds.
type Field struct {
	Kind  FieldKind
	Name  string
	Value string
	Index int64
}

// HeaderBlock is one decoded request/response header block.
//
// EncodedCount is E, Sign is S (0 or 1) and Delta is the non-negative delta
// used to recover the base. StreamID must be unique for the lifetime of the
// component, including after delivery or cancellation.
type HeaderBlock struct {
	StreamID     int64
	EncodedCount int64
	Sign         int
	Delta        int64
	Fields       []Field
}

// ResolvedField is a fully decoded field line with its provenance.
//
// StaticIndex is the static-table index for SourceStatic and -1 otherwise.
// DynamicIndex is the absolute dynamic-table index for SourceDynamic and -1
// otherwise.
type ResolvedField struct {
	Name         string
	Value        string
	Source       FieldSource
	StaticIndex  int64
	DynamicIndex int64
}

// ResolvedHeader is the complete, ordered result of one header block.
type ResolvedHeader struct {
	StreamID int64
	Fields   []ResolvedField
}

// Delivery hands one fully resolved header block back to the host.
type Delivery struct {
	StreamID int64
	Header   *ResolvedHeader
}

// ErrorEvidence retains the context of the operation that killed the decoder.
type ErrorEvidence struct {
	// Op names the failing operation, e.g. "insert", "set_capacity",
	// "header_block", "pump".
	Op string
	// StreamID is the affected stream when the error is stream scoped, else -1.
	StreamID int64
	// InsertCount is the total insert count observed at failure time.
	InsertCount int64
	// Header is a copy of the offending header block when one exists.
	Header *HeaderBlock
	// Detail is a human-readable description.
	Detail string
}

// DecodeError is the terminal error of a connection component. Once returned,
// the decoder is stopped and the same error is returned for every later
// operation.
type DecodeError struct {
	Code     string
	Evidence ErrorEvidence
}

func (e *DecodeError) Error() string {
	if e.Evidence.StreamID >= 0 {
		return "qpackdec: " + e.Code + ": stream " +
			itoa(e.Evidence.StreamID) + ": " + e.Evidence.Detail
	}
	return "qpackdec: " + e.Code + ": " + e.Evidence.Detail
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	n := len(buf)
	for v > 0 {
		n--
		buf[n] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		n--
		buf[n] = '-'
	}
	return string(buf[n:])
}
