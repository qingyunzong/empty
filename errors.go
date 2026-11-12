package dataeng

import (
	"fmt"
)

// CompileError reports a structural template error. It is returned before any
// data are decoded.
type CompileError struct {
	Descriptor *Descriptor
	Context    string
	Err        error
}

func (e *CompileError) Error() string {
	if e.Context != "" {
		return fmt.Sprintf("descriptor compile: %s: %v", e.Context, e.Err)
	}
	return fmt.Sprintf("descriptor compile: %v", e.Err)
}

// Unwrap supports errors.Is/errors.As against the underlying sentinel.
func (e *CompileError) Unwrap() error {
	return e.Err
}

// DecodeError reports the first failure in a message. Decode returns no
// observations when this error is non-nil, preserving message atomicity.
type DecodeError struct {
	Subset     int
	BitOffset  int
	Descriptor *Descriptor
	Path       []PathStep
	Err        error
}

func (e *DecodeError) Error() string {
	where := fmt.Sprintf("subset %d bit %d", e.Subset, e.BitOffset)
	if e.Descriptor != nil {
		where += " descriptor " + e.Descriptor.String()
	}
	if len(e.Path) != 0 {
		where += fmt.Sprintf(" path=%v", e.Path)
	}
	return fmt.Sprintf("descriptor decode: %s: %v", where, e.Err)
}

// Unwrap supports errors.Is/errors.As against the underlying sentinel.
func (e *DecodeError) Unwrap() error {
	return e.Err
}
