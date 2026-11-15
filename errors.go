package dataeng

import (
	"errors"
	"fmt"
	"strings"
)

// ErrorKind classifies a parse failure.
type ErrorKind string

const (
	ErrInvalidInput  ErrorKind = "invalid_input"
	ErrDelimiter     ErrorKind = "delimiter"
	ErrEscape        ErrorKind = "escape"
	ErrSegment       ErrorKind = "segment"
	ErrEnvelope      ErrorKind = "envelope"
	ErrTruncated     ErrorKind = "truncated_batch"
	ErrCountMismatch ErrorKind = "count_mismatch"
	ErrUnexpected    ErrorKind = "unexpected_segment"
	ErrIO            ErrorKind = "io"
)

// ParseError is a segment-addressable parsing failure. Line and Offset are
// one-based and zero-based respectively and refer to the original payload.
// Column is a one-based byte position within the original segment.
//
// Message, RawSegment and RawMessage are retained even when the batch itself is
// rejected, allowing the caller to route or replay the exact input.
type ParseError struct {
	Kind                ErrorKind
	Detail              string
	Line                int
	Offset              int
	Column              int
	SegmentID           string
	SegmentIndex        int
	MessageSegmentIndex int
	MessageIndex        int
	Segment             *Segment
	Message             *Message
	RawSegment          []byte
	RawMessage          []byte
	Evidence            *Envelope
	Batch               *Batch
	Cause               error
}

// Error implements error.
func (e *ParseError) Error() string {
	if e == nil {
		return "<nil>"
	}
	var location strings.Builder
	if e.Line > 0 {
		fmt.Fprintf(&location, " at line %d, byte %d", e.Line, e.Offset)
		if e.Column > 0 {
			fmt.Fprintf(&location, ", column %d", e.Column)
		}
	}
	if e.SegmentID != "" {
		fmt.Fprintf(&location, " (%s)", e.SegmentID)
	}
	if e.MessageIndex > 0 {
		fmt.Fprintf(&location, ", message %d", e.MessageIndex)
	}

	detail := e.Detail
	if detail == "" && e.Cause != nil {
		detail = e.Cause.Error()
	}
	if detail == "" {
		detail = "parse failed"
	}
	return fmt.Sprintf("hl7 %s%s: %s", e.Kind, location.String(), detail)
}

// Unwrap returns the underlying parser or I/O error, if any.
func (e *ParseError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

// MessageRaw returns a copy of the complete original message bytes.
func (e *ParseError) MessageRaw() []byte {
	if e == nil {
		return nil
	}
	return append([]byte(nil), e.RawMessage...)
}

// SegmentRaw returns a copy of the original segment bytes including its
// original terminator.
func (e *ParseError) SegmentRaw() []byte {
	if e == nil {
		return nil
	}
	return append([]byte(nil), e.RawSegment...)
}

// ErrorList is an ordered collection of parse failures.
type ErrorList []*ParseError

// Error implements error.
func (l ErrorList) Error() string {
	switch len(l) {
	case 0:
		return ""
	case 1:
		return l[0].Error()
	default:
		parts := make([]string, len(l))
		for i := range l {
			parts[i] = l[i].Error()
		}
		return strings.Join(parts, "; ")
	}
}

// Unwrap supports errors.As and errors.Is across every diagnostic.
func (l ErrorList) Unwrap() []error {
	errorsList := make([]error, 0, len(l))
	for _, parseErr := range l {
		if parseErr != nil {
			errorsList = append(errorsList, parseErr)
		}
	}
	return errorsList
}

// AsParseError returns the first ParseError in err.
func AsParseError(err error) (*ParseError, bool) {
	var parseErr *ParseError
	if errors.As(err, &parseErr) {
		return parseErr, true
	}
	return nil, false
}

func parseErrorAt(
	kind ErrorKind,
	detail string,
	record rawRecord,
	segment *Segment,
	message *Message,
	cause error,
) *ParseError {
	parseErr := &ParseError{
		Kind:       kind,
		Detail:     detail,
		Line:       record.line,
		Offset:     record.offset,
		SegmentID:  record.id,
		Segment:    segment,
		Message:    message,
		RawSegment: []byte(record.content + record.terminator),
		Cause:      cause,
	}
	if segment != nil {
		parseErr.SegmentIndex = segment.Index
		parseErr.SegmentID = segment.ID
		parseErr.MessageSegmentIndex = segment.MessageSegmentIndex
	}
	if message != nil {
		parseErr.MessageIndex = message.Index
	}
	return parseErr
}
