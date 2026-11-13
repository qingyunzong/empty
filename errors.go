package dataeng

import (
	"context"
	"errors"
	"fmt"
)

var (
	// ErrInvalidPlan means the plan cannot describe a valid device round.
	ErrInvalidPlan = errors.New("dataeng: invalid poll plan")
	// ErrInvalidRange means an interval is empty, disagrees with its aliases
	// or falls outside the 16-bit register space.
	ErrInvalidRange = errors.New("dataeng: invalid read range")
	// ErrIncomplete means a reader did not return every register in an
	// interval. A partial interval is never merged into a snapshot.
	ErrIncomplete = errors.New("dataeng: incomplete register range")
	// ErrConflict means two overlapping reads disagreed about a register.
	// The complete round is rejected when this error occurs.
	ErrConflict = errors.New("dataeng: overlapping register value conflict")
	// ErrGenerationChanged means the device restart counter changed while a
	// round was being assembled, so the round spans two generations.
	ErrGenerationChanged = errors.New("dataeng: device generation changed during round")
	// ErrReaderUnsupported means the supplied collector does not expose a
	// supported read method.
	ErrReaderUnsupported = errors.New("dataeng: unsupported register reader")
	// ErrTimeout is compatible with context deadline checks.
	ErrTimeout = context.DeadlineExceeded

	// Common vocabulary aliases.
	ErrOverlap        = ErrConflict
	ErrRestartChanged = ErrGenerationChanged
	ErrRoundTimeout   = ErrTimeout
)

// InvalidRangeError describes an unusable interval.
type InvalidRangeError struct {
	Range  ReadRange
	Reason string
}

func (e *InvalidRangeError) Error() string {
	return fmt.Sprintf("%v: %+v: %s", ErrInvalidRange, e.Range, e.Reason)
}

func (e *InvalidRangeError) Unwrap() error {
	return ErrInvalidRange
}

func invalidRangeError(r ReadRange, reason string) *InvalidRangeError {
	return &InvalidRangeError{Range: r, Reason: reason}
}

// ConflictError reports the first conflicting register found in a round.
type ConflictError struct {
	Address  uint16
	Existing uint16
	Incoming uint16

	// Readable aliases for callers that describe the two observations as
	// first and second values.
	First  uint16
	Second uint16
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("%v at address %d: %d != %d", ErrConflict, e.Address, e.Existing, e.Incoming)
}

func (e *ConflictError) Unwrap() error {
	return ErrConflict
}

// RangeError identifies the interval and attempt count that failed a round.
type RangeError struct {
	Range    ReadRange
	Attempts int
	Err      error
}

func (e *RangeError) Error() string {
	return fmt.Sprintf("dataeng: read range %+v failed after %d attempt(s): %v", e.Range, e.Attempts, e.Err)
}

func (e *RangeError) Unwrap() error {
	return e.Err
}
