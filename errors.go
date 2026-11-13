package dataeng

import (
	"errors"
	"fmt"
)

var (
	// ErrUnboundPrefix is returned when a QName uses a prefix that is not in
	// scope. The document is rejected; no partial event slice is returned by
	// Normalize.
	ErrUnboundPrefix = errors.New("dataeng: undeclared namespace prefix")
	// ErrUndeclaredPrefix is an alias for ErrUnboundPrefix.
	ErrUndeclaredPrefix = ErrUnboundPrefix
	// ErrUnknownEntity is returned for an entity reference that is not one of
	// the five predefined XML entities. General entity expansion is disabled.
	ErrUnknownEntity = errors.New("dataeng: unknown entity")
	// ErrEntityExpansion is an alias for ErrUnknownEntity.
	ErrEntityExpansion = ErrUnknownEntity
	// ErrInvalidNamespace is returned for an invalid namespace declaration.
	ErrInvalidNamespace = errors.New("dataeng: invalid namespace declaration")
	// ErrInvalidXMLBase is returned when an xml:base value is not a valid URI
	// reference.
	ErrInvalidXMLBase = errors.New("dataeng: invalid xml:base")
)

// PrefixError identifies the undeclared prefix and its original position.
type PrefixError struct {
	Prefix   string
	Position Position
}

func (e *PrefixError) Error() string {
	return fmt.Sprintf("%s %q at %s", ErrUnboundPrefix, e.Prefix, e.Position)
}

// Unwrap permits errors.Is(err, ErrUnboundPrefix).
func (e *PrefixError) Unwrap() error { return ErrUnboundPrefix }

// PositionError attaches an original input position to an error.
type PositionError struct {
	Position Position
	Err      error
}

func (e *PositionError) Error() string {
	return fmt.Sprintf("dataeng: %s: %v", e.Position, e.Err)
}

// Unwrap returns the wrapped error.
func (e *PositionError) Unwrap() error { return e.Err }
