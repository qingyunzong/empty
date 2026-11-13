package dataeng

import (
	"errors"
	"fmt"
)

// Sentinel errors returned by the parser. Use errors.Is to test for them.
var (
	ErrTruncated             = errors.New("truncated data set")
	ErrTooLarge              = errors.New("data set exceeds host limit")
	ErrMaxDepth              = errors.New("maximum nesting depth exceeded")
	ErrInvalidLength         = errors.New("invalid element or item length")
	ErrUnexpectedDelimiter   = errors.New("unexpected delimiter")
	ErrMissingDelimiter      = errors.New("missing delimiter")
	ErrExpectedItem          = errors.New("expected sequence item")
	ErrPrivateBeforeCreator  = errors.New("private element precedes its creator")
	ErrInvalidDelimiterValue = errors.New("delimiter has non-zero length")
)

// ParseError reports the byte offset at which parsing failed and the
// underlying sentinel error.
type ParseError struct {
	Offset int64
	Err    error
	Detail string
}

func (e *ParseError) Error() string {
	if e.Detail == "" {
		return fmt.Sprintf("dataeng: %v at byte offset %d", e.Err, e.Offset)
	}
	return fmt.Sprintf("dataeng: %v at byte offset %d: %s", e.Err, e.Offset, e.Detail)
}

// Unwrap allows errors.Is and errors.As to reach the sentinel error.
func (e *ParseError) Unwrap() error {
	return e.Err
}
