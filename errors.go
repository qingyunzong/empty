package formal

import "errors"

var (
	// ErrNotExist reports a missing namespace entry.
	ErrNotExist = errors.New("formal: path does not exist")
	// ErrExist reports that a namespace entry already exists.
	ErrExist = errors.New("formal: path already exists")
	// ErrNotDir reports that a path component is not a directory.
	ErrNotDir = errors.New("formal: not a directory")
	// ErrIsDir reports that an operation requiring a file was given a directory.
	ErrIsDir = errors.New("formal: is a directory")
	// ErrNotEmpty reports an operation that requires an empty directory.
	ErrNotEmpty = errors.New("formal: directory not empty")
	// ErrInvalidRename reports an attempt to move a directory into its own
	// subtree.
	ErrInvalidRename = errors.New("formal: invalid rename")
	// ErrRoot reports an operation that cannot be applied to the root.
	ErrRoot = errors.New("formal: operation on root is not allowed")
	// ErrNegativeSize reports a negative file size.
	ErrNegativeSize = errors.New("formal: negative file size")
	// ErrInvariant reports an internal accounting invariant violation.
	ErrInvariant = errors.New("formal: accounting invariant violated")
)
