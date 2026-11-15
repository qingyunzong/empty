package dataeng

import (
	"errors"
	"fmt"
)

var (
	// ErrInvalidTransaction is returned when a transaction cannot be applied
	// as a unit, for example because its ID is empty or a change is malformed.
	ErrInvalidTransaction = errors.New("dataeng: invalid transaction")

	// ErrInvalidSchema is returned for a malformed or conflicting schema.
	ErrInvalidSchema = errors.New("dataeng: invalid schema")

	// ErrSchemaNotFound is returned when a change has no inline primary key
	// and no schema was registered for its table generation.
	ErrSchemaNotFound = errors.New("dataeng: schema not found")

	// ErrUniqueViolation means an insert or migration target key already
	// exists. The whole transaction is rejected.
	ErrUniqueViolation = errors.New("dataeng: unique constraint violation")

	// ErrRowNotFound means a delete or update referenced a row that is not
	// present in the engine state.
	ErrRowNotFound = errors.New("dataeng: row not found")

	// ErrBeforeImageMismatch means a supplied before image disagrees with the
	// stored row. The engine refuses to guess which version is authoritative.
	ErrBeforeImageMismatch = errors.New("dataeng: before image does not match stored row")

	// ErrKeyChangeInUpdate means an update changed primary-key columns. CDC
	// key migrations must use a delete+insert pair so they can be identified
	// and assigned a stable migration ID.
	ErrKeyChangeInUpdate = errors.New("dataeng: update changes primary key")

	// ErrTransactionConflict means a transaction ID was reused with different
	// content. Silently accepting it would make recovery non-deterministic.
	ErrTransactionConflict = errors.New("dataeng: transaction ID reused with different content")
)

// UniqueViolationError carries the offending key without losing the sentinel
// error used by errors.Is.
type UniqueViolationError struct {
	Key   Key
	Where string
}

func (e *UniqueViolationError) Error() string {
	if e.Where != "" {
		return fmt.Sprintf("%v: %s (%s)", ErrUniqueViolation, e.Where, e.Key.String())
	}
	return fmt.Sprintf("%v: %s", ErrUniqueViolation, e.Key.String())
}

func (e *UniqueViolationError) Unwrap() error { return ErrUniqueViolation }

// RowNotFoundError identifies the missing key.
type RowNotFoundError struct {
	Key Key
}

func (e *RowNotFoundError) Error() string {
	return fmt.Sprintf("%v: %s", ErrRowNotFound, e.Key.String())
}

func (e *RowNotFoundError) Unwrap() error { return ErrRowNotFound }

// BeforeImageMismatchError names the first column whose stored value differs
// from the supplied before image.
type BeforeImageMismatchError struct {
	Key    Key
	Column string
}

func (e *BeforeImageMismatchError) Error() string {
	return fmt.Sprintf("%v: %s column %q", ErrBeforeImageMismatch, e.Key.String(), e.Column)
}

func (e *BeforeImageMismatchError) Unwrap() error { return ErrBeforeImageMismatch }
