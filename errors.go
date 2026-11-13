package dataeng

import "errors"

var (
	// ErrMailboxNotFound means that no state has been opened for the mailbox.
	ErrMailboxNotFound = errors.New("dataeng: mailbox not found")

	// ErrRevisionConflict means that a Commit expected an older revision.
	ErrRevisionConflict = errors.New("dataeng: revision conflict")

	// ErrStaleSnapshot means that state changed after the Snapshot was taken.
	// The response must be discarded; it must not be applied partially.
	ErrStaleSnapshot = errors.New("dataeng: stale snapshot")

	// ErrStaleGeneration means that UIDVALIDITY changed (or the mailbox was
	// reopened as another generation) after the request snapshot was taken.
	ErrStaleGeneration = errors.New("dataeng: stale mailbox generation")

	// ErrCursorRegression means that a server reported UIDNEXT or
	// HIGHESTMODSEQ below the value already durably recorded.
	ErrCursorRegression = errors.New("dataeng: recovery point regression")

	// ErrStaleMessage means that an update tried to lower a message's MODSEQ.
	ErrStaleMessage = errors.New("dataeng: message modseq regression")

	// ErrConflictingResponse means that one response contained contradictory
	// changes, such as an expunged UID that is also fetched.
	ErrConflictingResponse = errors.New("dataeng: conflicting sync response")

	// ErrUIDConflict means that a move tried to assign an already used UID.
	ErrUIDConflict = errors.New("dataeng: destination UID already exists")

	// ErrMessageNotFound means that a move referenced a source UID that is not
	// present in the source snapshot.
	ErrMessageNotFound = errors.New("dataeng: message not found")

	// ErrInvalidRequest means that caller-supplied data violates the API
	// contract.
	ErrInvalidRequest = errors.New("dataeng: invalid request")

	// ErrInvalidCommit means that a Store rejected a Commit because its
	// invariants were violated.
	ErrInvalidCommit = errors.New("dataeng: invalid commit")
)
