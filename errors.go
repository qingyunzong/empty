package dataeng

import "errors"

var (
	// ErrInvalidPage reports a page whose fields cannot be combined into a
	// consistent inventory record.
	ErrInvalidPage = errors.New("dataeng: invalid inventory page")

	// ErrMarkerNotAdvanced reports a truncated page whose continuation marker
	// did not move past the current cursor. Applying the page again cannot make
	// progress, so a collector should stop rather than loop forever.
	ErrMarkerNotAdvanced = errors.New("dataeng: pagination marker did not advance")

	// ErrTraversalComplete reports an attempt to apply another page after a
	// page with IsTruncated set to false has completed the generation.
	ErrTraversalComplete = errors.New("dataeng: traversal is already complete")

	// ErrIncompleteTraversal reports an attempt to publish a generation that
	// has not yet seen the final, non-truncated page of its traversal.
	ErrIncompleteTraversal = errors.New("dataeng: traversal is incomplete")

	// ErrNoActiveGeneration reports an operation that requires a staging
	// generation when the store does not have one.
	ErrNoActiveGeneration = errors.New("dataeng: no active generation")

	// ErrGenerationActive reports an attempt to start a generation while
	// another one is still open.
	ErrGenerationActive = errors.New("dataeng: another generation is active")

	// ErrGenerationClosed reports use of an aborted, superseded, or already
	// published generation.
	ErrGenerationClosed = errors.New("dataeng: generation is closed")

	// ErrRecordConflict reports the same (key, version ID) being observed both
	// as a version and as a delete marker. S3 cannot return both for one
	// version, so silently choosing one would hide a corrupt or mixed page set.
	ErrRecordConflict = errors.New("dataeng: conflicting version and delete marker")
)

// Compatibility aliases for callers that use shorter error names.
var (
	ErrNoProgress   = ErrMarkerNotAdvanced
	ErrNotComplete  = ErrIncompleteTraversal
	ErrNoGeneration = ErrNoActiveGeneration
)
