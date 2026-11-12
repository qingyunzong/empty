package dataeng

import (
	"errors"
	"fmt"
)

// Protocol and validation errors. Batch-local failures additionally carry the
// batch sequence through *BatchError; the stream remains usable after them.
var (
	ErrSchemaRequired     = errors.New("dataeng: schema message must be first")
	ErrSchemaAlreadySet   = errors.New("dataeng: schema may only be declared once")
	ErrClosed             = errors.New("dataeng: stream is closed")
	ErrInvalidMessage     = errors.New("dataeng: invalid message")
	ErrUnknownColumn      = errors.New("dataeng: unknown column")
	ErrUnknownDictionary  = errors.New("dataeng: unknown dictionary")
	ErrInvalidGeneration  = errors.New("dataeng: generation must be at least 1")
	ErrInvalidMode        = errors.New("dataeng: invalid dictionary mode")
	ErrGenerationConflict = errors.New("dataeng: dictionary generation conflict")
	ErrInvalidIndex       = errors.New("dataeng: invalid dictionary index")
	ErrMissingGeneration  = errors.New("dataeng: dictionary generation is missing")
	ErrPendingBatch       = errors.New("dataeng: batch is still waiting for dictionaries")
	ErrTypeMismatch       = errors.New("dataeng: column type mismatch")
	ErrDuplicateColumn    = errors.New("dataeng: duplicate column in batch")
	ErrColumnLength       = errors.New("dataeng: columns in a batch have different lengths")
)

// MissingGenerationError names a generation that never arrived.
type MissingGenerationError struct {
	DictionaryID string
	Generation   int
}

func (e *MissingGenerationError) Error() string {
	return fmt.Sprintf("dataeng: dictionary %q is missing generation %d", e.DictionaryID, e.Generation)
}

func (e *MissingGenerationError) Unwrap() error { return ErrMissingGeneration }

// GenerationConflictError is returned when the same dictionary generation is
// replayed with different content.
type GenerationConflictError struct {
	DictionaryID string
	Generation   int
}

func (e *GenerationConflictError) Error() string {
	return fmt.Sprintf("dataeng: dictionary %q generation %d was redelivered with different content", e.DictionaryID, e.Generation)
}

func (e *GenerationConflictError) Unwrap() error { return ErrGenerationConflict }

// UnknownDictionaryError names an undeclared dictionary ID.
type UnknownDictionaryError struct {
	DictionaryID string
}

func (e *UnknownDictionaryError) Error() string {
	return fmt.Sprintf("dataeng: dictionary %q is not declared by the schema", e.DictionaryID)
}

func (e *UnknownDictionaryError) Unwrap() error { return ErrUnknownDictionary }

// UnknownColumnError names an undeclared column.
type UnknownColumnError struct {
	Column string
}

func (e *UnknownColumnError) Error() string {
	return fmt.Sprintf("dataeng: column %q is not declared by the schema", e.Column)
}

func (e *UnknownColumnError) Unwrap() error { return ErrUnknownColumn }

// DictionaryIndexError describes an index that cannot be decoded against the
// frozen generation. It only fails the affected batch.
type DictionaryIndexError struct {
	DictionaryID string
	Generation   int
	Column       string
	Index        int
	Length       int
}

func (e *DictionaryIndexError) Error() string {
	return fmt.Sprintf("dataeng: column %q index %d is invalid for dictionary %q generation %d with %d entries", e.Column, e.Index, e.DictionaryID, e.Generation, e.Length)
}

func (e *DictionaryIndexError) Unwrap() error { return ErrInvalidIndex }

// BatchError attaches a batch sequence to a batch-local failure.
type BatchError struct {
	Sequence int
	Err      error
}

func (e *BatchError) Error() string {
	return fmt.Sprintf("dataeng: batch %d failed: %v", e.Sequence, e.Err)
}

func (e *BatchError) Unwrap() error { return e.Err }

// PendingBatchError reports a batch that was still waiting when Close was
// called.
type PendingBatchError struct {
	Sequence int
	Missing  []MissingGenerationError
}

func (e *PendingBatchError) Error() string {
	if len(e.Missing) == 0 {
		return fmt.Sprintf("dataeng: batch %d is still pending", e.Sequence)
	}
	return fmt.Sprintf("dataeng: batch %d is still pending for dictionary %q generation %d", e.Sequence, e.Missing[0].DictionaryID, e.Missing[0].Generation)
}

func (e *PendingBatchError) Unwrap() []error {
	unwrapped := make([]error, 0, len(e.Missing)+1)
	unwrapped = append(unwrapped, ErrPendingBatch)
	for i := range e.Missing {
		unwrapped = append(unwrapped, &e.Missing[i])
	}
	return unwrapped
}
