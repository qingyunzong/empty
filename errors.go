package dataeng

import (
	"errors"
	"fmt"
	"strconv"
)

var (
	// ErrInvalidInput identifies structurally invalid histograms, invalid
	// scales, or a supplied total count that does not match the bucket sum.
	ErrInvalidInput = errors.New("dataeng: invalid input")

	// ErrCountOverflow identifies uint64 overflow in an input sum or in a
	// merge intermediate.
	ErrCountOverflow = errors.New("dataeng: count overflow")

	// ErrCapacity identifies a merge for which even scale -8 exceeds
	// MaxSpan. Errors of the concrete type *CapacityError also unwrap to
	// this sentinel.
	ErrCapacity = errors.New("dataeng: capacity insufficient")
)

func invalidf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidInput, fmt.Sprintf(format, args...))
}

func overflowf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrCountOverflow, fmt.Sprintf(format, args...))
}

func formatInt(v int) string {
	return strconv.Itoa(v)
}

func formatInt64(v int64) string {
	return strconv.FormatInt(v, 10)
}
