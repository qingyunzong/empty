package dataeng

import "errors"

var (
	// ErrSessionNotFound is returned when a session ID is unknown to the store.
	ErrSessionNotFound = errors.New("dataeng: session not found")
	// ErrSessionExists is returned when creating a session with a duplicate ID.
	ErrSessionExists = errors.New("dataeng: session already exists")
	// ErrSessionNotActive is returned when an operation requires an active session.
	ErrSessionNotActive = errors.New("dataeng: session is not active")
	// ErrSessionTerminal is returned when an operation conflicts with the
	// terminal state the session has already reached.
	ErrSessionTerminal = errors.New("dataeng: session already reached a terminal state")
	// ErrOperationInFlight is returned when a complete or abort is already running.
	ErrOperationInFlight = errors.New("dataeng: another operation is in flight for the session")
	// ErrPartConflict is returned when a part number is reused with different
	// content, or when the remote ETag disagrees with the recorded one.
	ErrPartConflict = errors.New("dataeng: conflicting content for part number")
	// ErrOrphanPart is returned when the remote upload contains parts that were
	// never recorded in the session manifest.
	ErrOrphanPart = errors.New("dataeng: remote part not recorded in session manifest")
	// ErrNoParts is returned when completing an upload that has no parts.
	ErrNoParts = errors.New("dataeng: cannot complete upload with no parts")
	// ErrInvalidPartNumber is returned for part numbers outside [1, 10000].
	ErrInvalidPartNumber = errors.New("dataeng: part number out of range")
	// ErrUploadNotFound is returned when the remote upload ID no longer exists.
	ErrUploadNotFound = errors.New("dataeng: remote upload not found")
	// ErrInvalidPart is returned by backends when a complete request references
	// a part that does not belong to the upload.
	ErrInvalidPart = errors.New("dataeng: invalid part in complete request")
)
