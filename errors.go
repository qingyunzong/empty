package dataeng

import "errors"

var (
	// ErrTruncated means the input ends before a declared field or record body.
	ErrTruncated = errors.New("dataeng: truncated data")
	// ErrInvalidBatch means the batch envelope or a batch-level field is malformed.
	ErrInvalidBatch = errors.New("dataeng: invalid record batch")
	// ErrUnsupportedMagic means the batch is not the supported Kafka magic 2 format.
	ErrUnsupportedMagic = errors.New("dataeng: unsupported record batch magic")
	// ErrUnsupportedCompression means the batch uses a compression codec this reader does not decode.
	ErrUnsupportedCompression = errors.New("dataeng: unsupported compression codec")
	// ErrInvalidRecord means a record field is structurally malformed.
	ErrInvalidRecord = errors.New("dataeng: invalid record")
	// ErrInvalidVarint means a varint is malformed or overlong.
	ErrInvalidVarint = errors.New("dataeng: invalid varint")
	// ErrRecordTooLarge means a record's declared length exceeds the host limit.
	ErrRecordTooLarge = errors.New("dataeng: record exceeds host limit")
	// ErrInvalidOffsetDelta means an offset delta is negative, overflows, or is unordered.
	ErrInvalidOffsetDelta = errors.New("dataeng: invalid offset delta")
	// ErrRecordOrder means record offsets are not strictly increasing.
	ErrRecordOrder = errors.New("dataeng: record offsets are not strictly increasing")
	// ErrLastOffsetMismatch means baseOffset + lastOffsetDelta is not the last record offset.
	ErrLastOffsetMismatch = errors.New("dataeng: batch last offset does not match the last record")
	// ErrTimestampAfterMax means a record timestamp is greater than the batch maximum timestamp.
	ErrTimestampAfterMax = errors.New("dataeng: record timestamp exceeds batch maximum")
	// ErrInvalidTimestamp means a timestamp delta overflows int64.
	ErrInvalidTimestamp = errors.New("dataeng: invalid timestamp")
	// ErrInvalidControlRecord means a control-record key cannot be decoded.
	ErrInvalidControlRecord = errors.New("dataeng: invalid control record")
	// ErrUnknownTransactionMarker means a control record names a marker other than commit or abort.
	ErrUnknownTransactionMarker = errors.New("dataeng: unknown transaction marker")
)
