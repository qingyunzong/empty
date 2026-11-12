package dataeng

import "errors"

var (
	// ErrInvalidParameter reports an unsupported block width, checkpoint
	// interval or logical length supplied to Encode.
	ErrInvalidParameter = errors.New("dataeng: invalid parameter")

	// ErrInvalidBit reports an input byte that is neither 0 nor 1.
	ErrInvalidBit = errors.New("dataeng: input bit must be 0 or 1")

	// ErrMalformedHeader reports an invalid fixed header.
	ErrMalformedHeader = errors.New("dataeng: malformed header")

	// ErrMalformedPayload reports an invalid per-block class or ordinal.
	ErrMalformedPayload = errors.New("dataeng: malformed payload")

	// ErrTruncated reports a snapshot or bit stream that ends too early.
	ErrTruncated = errors.New("dataeng: truncated data")

	// ErrBadPadding reports non-zero padding bits in the last byte.
	ErrBadPadding = errors.New("dataeng: non-zero padding")

	// ErrTrailingData reports bytes after the final padded byte.
	ErrTrailingData = errors.New("dataeng: trailing payload bytes")

	// ErrOutOfRange reports an invalid logical position or negative select
	// index.
	ErrOutOfRange = errors.New("dataeng: position out of range")
)
