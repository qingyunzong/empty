package dataeng

import "errors"

var (
	// ErrInvalidSpec indicates that a DownloadSpec is missing required data or
	// contains an invalid value.
	ErrInvalidSpec = errors.New("dataeng: invalid download spec")
	// ErrInvalidID indicates that a download ID is empty.
	ErrInvalidID = errors.New("dataeng: invalid download id")
	// ErrInvalidFilename indicates that a suggested filename cannot be used as
	// a single, non-special path element.
	ErrInvalidFilename = errors.New("dataeng: invalid suggested filename")
	// ErrInvalidTempPath indicates that a temporary path is empty.
	ErrInvalidTempPath = errors.New("dataeng: invalid temporary path")
	// ErrInvalidDigest indicates that an expected SHA-256 digest is malformed.
	ErrInvalidDigest = errors.New("dataeng: invalid SHA-256 digest")
	// ErrInvalidSize indicates that an expected size is negative.
	ErrInvalidSize = errors.New("dataeng: invalid expected size")
	// ErrDuplicateDownload indicates that a download ID is already tracked.
	ErrDuplicateDownload = errors.New("dataeng: download id is already tracked")
	// ErrUnknownDownload indicates that a download ID was never registered.
	ErrUnknownDownload = errors.New("dataeng: unknown download id")
	// ErrIDMismatch indicates that a completion event carries an ID that does
	// not match the download it was applied to.
	ErrIDMismatch = errors.New("dataeng: completion event id does not match")
	// ErrCanceled indicates that a download was canceled before publication.
	ErrCanceled = errors.New("dataeng: download canceled")
	// ErrAlreadyPublished indicates that a download has already been published.
	ErrAlreadyPublished = errors.New("dataeng: download already published")
	// ErrPublishing indicates that publication is already in progress.
	ErrPublishing = errors.New("dataeng: download publication already in progress")
	// ErrNotRegularFile indicates that the temporary path is not a regular file.
	ErrNotRegularFile = errors.New("dataeng: temporary path is not a regular file")
	// ErrSizeMismatch indicates that the settled file has the wrong length.
	ErrSizeMismatch = errors.New("dataeng: download size mismatch")
	// ErrDigestMismatch indicates that the file's SHA-256 digest does not match
	// the expected digest.
	ErrDigestMismatch = errors.New("dataeng: download digest mismatch")
	// ErrTargetIsDirectory indicates that overwriting would replace a directory.
	ErrTargetIsDirectory = errors.New("dataeng: publication target is a directory")
	// ErrNameExhausted indicates that no unused collision-free name was found.
	ErrNameExhausted = errors.New("dataeng: could not allocate a unique filename")
)

var errFileChanged = errors.New("dataeng: file changed while being verified")
