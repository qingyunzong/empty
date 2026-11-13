package dataeng

import (
	"errors"
	"fmt"
)

var (
	// ErrExternalEntity reports an external entity or external DTD subset.
	ErrExternalEntity = errors.New("dataeng: external entity rejected")
	// ErrExpansionLimit reports that internal entity expansion exceeded the
	// caller-provided byte limit.
	ErrExpansionLimit = errors.New("dataeng: internal entity expansion limit exceeded")
	// ErrUndeclaredPrefix reports a namespace prefix that is not in scope.
	ErrUndeclaredPrefix = errors.New("dataeng: undeclared namespace prefix")
	// ErrUndefinedEntity reports a reference to an entity that was not declared.
	ErrUndefinedEntity = errors.New("dataeng: undefined entity")
	// ErrEntityLoop reports a recursive entity reference.
	ErrEntityLoop = errors.New("dataeng: recursive entity reference")
	// ErrEntityDepth reports entity nesting that is too deep.
	ErrEntityDepth = errors.New("dataeng: entity reference nesting too deep")
	// ErrInvalidLimit reports a negative expansion limit.
	ErrInvalidLimit = errors.New("dataeng: invalid expansion limit")
	// ErrUnsupported reports an XML construct this fragment reader does not
	// implement.
	ErrUnsupported = errors.New("dataeng: unsupported XML construct")
	// ErrMalformed reports malformed XML.
	ErrMalformed = errors.New("dataeng: malformed XML fragment")
)

// ParseError describes an error and the byte offset at which it was detected.
type ParseError struct {
	Offset int
	Err    error
	Detail string
}

func (e *ParseError) Error() string {
	if e.Detail == "" {
		return fmt.Sprintf("%v at byte %d", e.Err, e.Offset)
	}
	return fmt.Sprintf("%v at byte %d: %s", e.Err, e.Offset, e.Detail)
}

// Unwrap makes errors.Is and errors.As work with the exported error values.
func (e *ParseError) Unwrap() error { return e.Err }
