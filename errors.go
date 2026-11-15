package dataeng

import "errors"

// Sentinel errors returned by the state library. Callers can use errors.Is
// to detect a specific failure class regardless of the wrapping context.
var (
	// ErrInvalidArgument is returned when a caller supplies a value that
	// cannot be represented in IMAP state, such as a zero UID or an empty
	// mailbox name.
	ErrInvalidArgument = errors.New("dataeng: invalid argument")

	// ErrUnknownMailbox is returned when an operation targets a mailbox that
	// has never been selected on this state.
	ErrUnknownMailbox = errors.New("dataeng: unknown mailbox")

	// ErrGenerationNotFound is returned when a caller asks for a generation
	// number that does not exist for the given mailbox.
	ErrGenerationNotFound = errors.New("dataeng: generation not found")

	// ErrNoSnapshot is returned by a Store when no persisted snapshot exists
	// yet, for example on the very first run of an archiver.
	ErrNoSnapshot = errors.New("dataeng: no persisted snapshot")
)
