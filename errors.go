package dataeng

import "fmt"

// CompileError reports a rejected AST. Path identifies the offending node.
type CompileError struct {
	Path   string
	Reason string
}

func (e *CompileError) Error() string {
	if e.Path == "" {
		return "dataeng: compile: " + e.Reason
	}
	return fmt.Sprintf("dataeng: compile %q: %s", e.Path, e.Reason)
}

// DecodeErrorCode classifies a runtime rejection.
type DecodeErrorCode string

const (
	ErrBounds     DecodeErrorCode = "bounds"
	ErrDigit      DecodeErrorCode = "digit"
	ErrSign       DecodeErrorCode = "sign"
	ErrCount      DecodeErrorCode = "count"
	ErrBranch     DecodeErrorCode = "branch"
	ErrLeafLimit  DecodeErrorCode = "leaf-limit"
	ErrRecordSize DecodeErrorCode = "record-size"
)

// DecodeError reports a rejected record. Path is the offending field path and
// Offset is its physical byte offset from the start of the record.
type DecodeError struct {
	Code   DecodeErrorCode
	Path   string
	Offset int
	Reason string
}

func (e *DecodeError) Error() string {
	return fmt.Sprintf("dataeng: decode %s at %q offset %d: %s", e.Code, e.Path, e.Offset, e.Reason)
}
