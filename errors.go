package dataeng

import (
	"errors"
	"fmt"
)

var (
	// ErrIncomplete means Finish was called while a frame prefix or payload
	// was still incomplete.
	ErrIncomplete = errors.New("dataeng: incomplete frame")

	// ErrFinished means input was supplied after a successful Finish.
	ErrFinished = errors.New("dataeng: decoder is finished")
)

// FrameError reports a malformed length prefix or incomplete payload.
type FrameError struct {
	Reason string
}

func (e *FrameError) Error() string {
	return "dataeng: bad frame: " + e.Reason
}

// ParseError reports a malformed payload and its byte offset.
type ParseError struct {
	Offset int
	Reason string
}

func (e *ParseError) Error() string {
	return fmt.Sprintf("dataeng: payload byte %d: %s", e.Offset, e.Reason)
}
