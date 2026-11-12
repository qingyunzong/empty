package signal

import "errors"

// Validation and decoding errors. Errors are wrapped, so callers can use
// errors.Is against these sentinels while retaining the detailed message.
var (
	// ErrConfig is returned for malformed pattern configuration that is not
	// covered by a more specific sentinel below.
	ErrConfig = errors.New("signal: invalid pattern configuration")

	// ErrOutOfRange is returned when a bit position falls outside the frame.
	ErrOutOfRange = errors.New("signal: bit position out of range")

	// ErrDuplicateBits is returned when one signal repeats a bit position.
	ErrDuplicateBits = errors.New("signal: duplicated bit position in signal")

	// ErrOverlap is returned when signals that can be active together share
	// one or more bit positions, including selector bit segments.
	ErrOverlap = errors.New("signal: overlapping simultaneously active signals")

	// ErrSelector is returned when a selector reference is missing, a selector
	// is signed, or a selector itself depends on another selector.
	ErrSelector = errors.New("signal: invalid selector")

	// ErrCycle is returned when the selector dependency graph has a cycle.
	ErrCycle = errors.New("signal: selector dependency cycle")

	// ErrRational is returned when a scale or offset has a zero denominator.
	ErrRational = errors.New("signal: zero-denominator rational")

	// ErrFrameLength is returned when a frame byte slice does not match the
	// declared pattern length.
	ErrFrameLength = errors.New("signal: frame length mismatch")
)
