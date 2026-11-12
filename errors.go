package dataeng

import "errors"

// Errors reported by the decoder. Parse errors wrap one of these sentinels so
// callers can classify failures with errors.Is.
var (
	// ErrIncomplete means Finish was called before a complete value arrived.
	ErrIncomplete = errors.New("dataeng: incomplete value")

	// ErrTrailingBytes means bytes followed the single decoded value.
	ErrTrailingBytes = errors.New("dataeng: trailing bytes after value")

	// ErrNonMinimalVarint means a LEB128 integer used more bytes than needed.
	ErrNonMinimalVarint = errors.New("dataeng: non-minimal varint")

	// ErrVarintOverflow means a varint used too many bytes or set reserved
	// high bits in its final byte.
	ErrVarintOverflow = errors.New("dataeng: varint exceeds its width")

	// ErrValueRange means a zig-zag result did not fit its signed target.
	ErrValueRange = errors.New("dataeng: integer value out of range")

	// ErrNegativeQuantity means a count or byte length was negative.
	ErrNegativeQuantity = errors.New("dataeng: negative count or length")

	// ErrFieldID means a field identifier was non-positive or not strictly
	// greater than the previous identifier.
	ErrFieldID = errors.New("dataeng: invalid field identifier")

	// ErrCorrupt means the payload header was structurally invalid.
	ErrCorrupt = errors.New("dataeng: corrupt payload")

	// ErrSchema means the caller-supplied schema is invalid.
	ErrSchema = errors.New("dataeng: invalid schema")

	// ErrSchemaMismatch means the payload did not match the schema: a missing
	// field, an unexpected field, or a type mismatch.
	ErrSchemaMismatch = errors.New("dataeng: payload does not match schema")

	// ErrBudget means a host budget (depth, element count, or byte length)
	// was exceeded.
	ErrBudget = errors.New("dataeng: host budget exceeded")
)
