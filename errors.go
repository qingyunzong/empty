package dataeng

import (
	"errors"
	"fmt"
)

var (
	// ErrConflict marks a data overlap whose bytes differ.
	ErrConflict = errors.New("dataeng: overlapping literal bytes conflict")
	// ErrGap marks missing octets in a section.
	ErrGap = errors.New("dataeng: section has a gap")
	// ErrTruncated marks a literal that is provably shorter than the server's
	// available section data. It is only provable when the expected section
	// size is known.
	ErrTruncated = errors.New("dataeng: server truncated the literal")
	// ErrIncomplete marks a section or message that does not have complete
	// coverage yet.
	ErrIncomplete = errors.New("dataeng: section is incomplete")
	// ErrExpectedSizeUnknown marks a section whose total size was not supplied.
	// Without that size a short final literal cannot be distinguished from a
	// truncated literal.
	ErrExpectedSizeUnknown = errors.New("dataeng: expected section size is unknown")
	// ErrUnknownSection marks a section that has not been seen.
	ErrUnknownSection = errors.New("dataeng: unknown section")
	// ErrInvalidSegment marks an invalid caller-supplied segment.
	ErrInvalidSegment = errors.New("dataeng: invalid segment")
	// ErrOutOfBounds marks a literal beyond the declared section size.
	ErrOutOfBounds = errors.New("dataeng: literal is outside the section")
	// ErrMessageFailed marks a message that has already failed because of a
	// conflict or an inconsistent server response.
	ErrMessageFailed = errors.New("dataeng: message failed")
	// ErrExpectedSizeConflict marks an attempt to declare a different size for
	// a section whose size is already known.
	ErrExpectedSizeConflict = errors.New("dataeng: conflicting expected section size")
	// ErrLiteralTooLong marks a literal that is longer than the FETCH window
	// that requested it.
	ErrLiteralTooLong = errors.New("dataeng: literal is longer than the request")
)

// ConflictError describes the first differing octet in an overlapping
// fragment. Offset is relative to the start of the section.
type ConflictError struct {
	Section  Section
	Origin   int64
	Offset   int64
	Existing byte
	Incoming byte
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf(
		"dataeng: section %q has conflicting bytes at offset %d: existing 0x%02x, incoming 0x%02x (fragment origin %d)",
		e.Section, e.Offset, e.Existing, e.Incoming, e.Origin,
	)
}

// Unwrap makes errors.Is(err, ErrConflict) report true.
func (e *ConflictError) Unwrap() error { return ErrConflict }

// OutOfBoundsError describes a literal that extends beyond the expected size
// of a section.
type OutOfBoundsError struct {
	Section  Section
	Origin   int64
	End      int64
	Expected int64
}

func (e *OutOfBoundsError) Error() string {
	return fmt.Sprintf(
		"dataeng: section %q literal [%d,%d) exceeds expected size %d",
		e.Section, e.Origin, e.End, e.Expected,
	)
}

func (e *OutOfBoundsError) Unwrap() error { return ErrOutOfBounds }

// ExpectedSizeError describes a size declaration that contradicts recorded
// data or an earlier declaration.
type ExpectedSizeError struct {
	Section  Section
	Existing int64
	Incoming int64
	Reason   string
}

func (e *ExpectedSizeError) Error() string {
	return fmt.Sprintf(
		"dataeng: section %q expected size %d conflicts with %s (existing %d)",
		e.Section, e.Incoming, e.Reason, e.Existing,
	)
}

func (e *ExpectedSizeError) Unwrap() error {
	if e.Reason == "recorded data" {
		return ErrOutOfBounds
	}
	return ErrExpectedSizeConflict
}

// IncompleteError describes a section that cannot be materialized yet.
type IncompleteError struct {
	Section       Section
	ExpectedKnown bool
	Expected      int64
	Received      int64
	Missing       []Range
}

func (e *IncompleteError) Error() string {
	if !e.ExpectedKnown {
		return fmt.Sprintf(
			"dataeng: section %q is incomplete: expected size is unknown (%d octets received)",
			e.Section, e.Received,
		)
	}
	return fmt.Sprintf(
		"dataeng: section %q is incomplete: %d of %d octets received, missing %v",
		e.Section, e.Received, e.Expected, e.Missing,
	)
}

// Unwrap makes errors.Is(err, ErrIncomplete) report true. When Missing is
// non-empty, errors.Is(err, ErrGap) also reports true.
func (e *IncompleteError) Unwrap() error { return ErrIncomplete }

// Is lets callers test for both ErrIncomplete and ErrGap.
func (e *IncompleteError) Is(target error) bool {
	return target == ErrIncomplete ||
		(target == ErrGap && len(e.Missing) > 0) ||
		(!e.ExpectedKnown && target == ErrExpectedSizeUnknown)
}

// TruncatedError describes a short literal that is provably incomplete for
// the section's known size.
type TruncatedError struct {
	Section   Section
	Origin    int64
	Requested int64
	Received  int64
	Needed    int64
}

func (e *TruncatedError) Error() string {
	return fmt.Sprintf(
		"dataeng: section %q literal at offset %d was truncated: requested %d, needed %d, received %d",
		e.Section, e.Origin, e.Requested, e.Needed, e.Received,
	)
}

func (e *TruncatedError) Unwrap() error { return ErrTruncated }

// Is makes a truncation also report as incomplete while it still has missing
// octets.
func (e *TruncatedError) Is(target error) bool {
	return target == ErrTruncated || target == ErrIncomplete
}

// MessageFailedError preserves the cause of a failed message while also
// matching ErrMessageFailed.
type MessageFailedError struct {
	Cause error
}

func (e *MessageFailedError) Error() string {
	return fmt.Sprintf("%s: %v", ErrMessageFailed, e.Cause)
}

func (e *MessageFailedError) Unwrap() error { return e.Cause }

func (e *MessageFailedError) Is(target error) bool {
	return target == ErrMessageFailed || errors.Is(e.Cause, target)
}
