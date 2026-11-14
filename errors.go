package dataeng

import (
	"errors"
	"io/fs"
)

var (
	// ErrObjectNotFound is returned by Store.Get when the requested object
	// does not exist. Store implementations may wrap it.
	ErrObjectNotFound = errors.New("dataeng: object not found")

	// ErrConflict is returned by a conditional write when the object no
	// longer matches the expected token. It is also returned by a publisher
	// that exhausted its rebase attempts.
	ErrConflict = errors.New("dataeng: conditional write conflict")

	// ErrConditionFailed is an alias of ErrConflict, matching the common
	// object-store terminology for a failed precondition.
	ErrConditionFailed = ErrConflict

	// ErrNoHead is returned when a reader is asked for a head before any
	// batch has been published.
	ErrNoHead = errors.New("dataeng: no published head")

	// ErrEmptyBatch is returned when an empty batch would be committed.
	ErrEmptyBatch = errors.New("dataeng: empty batch")

	// ErrCorrupt marks immutable data that does not match its content
	// address.
	ErrCorrupt = errors.New("dataeng: corrupt object")

	// ErrDigestMismatch is returned when a manifest or data object does not
	// match the digest recorded for it.
	ErrDigestMismatch = errors.New("dataeng: digest mismatch")

	// ErrParentMismatch is returned when a manifest's parent or generation
	// does not agree with the pointer or the parent manifest.
	ErrParentMismatch = errors.New("dataeng: parent manifest mismatch")

	// ErrInvalidManifest is returned for malformed or inconsistent manifest
	// metadata.
	ErrInvalidManifest = errors.New("dataeng: invalid manifest")

	// ErrInvalidPointer is returned for a malformed HEAD pointer.
	ErrInvalidPointer = errors.New("dataeng: invalid pointer")

	// ErrDuplicatePath is returned when one batch contains the same logical
	// path more than once.
	ErrDuplicatePath = errors.New("dataeng: duplicate path in batch")

	// ErrPathNotFound is returned when a logical path is not present in the
	// visible snapshot.
	ErrPathNotFound = errors.New("dataeng: path not found")
)

// IsNotFound reports whether err denotes a missing object. It accepts both
// ErrObjectNotFound and the standard fs.ErrNotExist, which makes file-system
// backed Store adapters easy to connect.
func IsNotFound(err error) bool {
	return errors.Is(err, ErrObjectNotFound) || errors.Is(err, fs.ErrNotExist)
}
