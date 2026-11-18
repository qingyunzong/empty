package formal

import (
	"errors"
	"fmt"
)

var (
	// ErrClosed is returned after the coordinator has been closed.
	ErrClosed = errors.New("formal: coordinator is closed")

	// ErrTxnNotFound is returned when an operation names an unknown transaction.
	ErrTxnNotFound = errors.New("formal: transaction not found")

	// ErrInvalidTxnID is returned for an empty transaction identifier.
	ErrInvalidTxnID = errors.New("formal: empty transaction identifier")

	// ErrNotOpen is returned when records are appended to a transaction that
	// can no longer accept records.
	ErrNotOpen = errors.New("formal: transaction is not open")

	// ErrNotPrepared is returned when Commit is called before Prepare.
	ErrNotPrepared = errors.New("formal: transaction is not prepared")

	// ErrAborted is returned when a prepared or open transaction was aborted.
	ErrAborted = errors.New("formal: transaction was aborted")

	// ErrAlreadyCommitted is returned when Abort is called for a transaction
	// whose commit point is already durable.
	ErrAlreadyCommitted = errors.New("formal: transaction is already committed")

	// ErrDuplicateRecord is returned when the same record identifier occurs
	// more than once in a transaction.
	ErrDuplicateRecord = errors.New("formal: duplicate record identifier")

	// ErrRecordConflict is returned when a record identifier was already made
	// visible by another transaction.
	ErrRecordConflict = errors.New("formal: record already belongs to another transaction")

	// ErrCorruptLog is returned when replay finds a journal that cannot be
	// interpreted without guessing. A torn final record is not corruption; it
	// is discarded as an incomplete commit.
	ErrCorruptLog = errors.New("formal: corrupt commit log")

	// ErrCrash is matched by errors caused by an injected crash checkpoint.
	ErrCrash = errors.New("formal: injected crash")

	// ErrConflict is returned by an idempotent sink when the same transaction
	// is retried with a different payload.
	ErrConflict = errors.New("formal: conflicting retry")
)

// CrashError records the checkpoint at which a fault was injected. The
// coordinator in which the error occurred has failed closed; reopen the same
// directory to exercise recovery.
type CrashError struct {
	Point CrashPoint
	Cause error
}

func (e *CrashError) Error() string {
	if e.Cause == nil {
		return fmt.Sprintf("%s at %s", ErrCrash, e.Point)
	}
	return fmt.Sprintf("%s at %s: %v", ErrCrash, e.Point, e.Cause)
}

// Unwrap preserves the error returned by the checkpoint callback.
func (e *CrashError) Unwrap() error { return e.Cause }

// Is makes errors.Is(err, ErrCrash) work even when the checkpoint returned a
// more specific sentinel.
func (e *CrashError) Is(target error) bool {
	return target == ErrCrash
}
