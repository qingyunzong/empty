package dataeng

import "errors"

var (
	// ErrInvalidHeader reports a malformed, inconsistent, or unsupported
	// primary header.
	ErrInvalidHeader = errors.New("fits: invalid header")

	// ErrTruncated reports a file or read shorter than the FITS layout
	// requires.
	ErrTruncated = errors.New("fits: truncated input")

	// ErrInvalidPadding reports nonzero data padding or spaces missing from
	// the remainder of the END card's 2880-byte block.
	ErrInvalidPadding = errors.New("fits: invalid padding")

	// ErrTrailingData reports bytes after the padded primary HDU, including
	// a second HDU.
	ErrTrailingData = errors.New("fits: trailing data or second HDU")

	// ErrInvalidRegion reports a non-half-open or out-of-bounds rectangle.
	ErrInvalidRegion = errors.New("fits: invalid read region")

	// ErrResourceLimit reports a header-card or output-pixel limit.
	ErrResourceLimit = errors.New("fits: resource limit exceeded")
)
