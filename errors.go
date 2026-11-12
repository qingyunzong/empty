package dataeng

import "errors"

// Sentinel errors returned by the package. All validation failures wrap one
// of these errors so callers can match them with errors.Is.
var (
	// ErrMetadata describes an invalid CDF-1 metadata structure.
	ErrMetadata = errors.New("cdf: invalid metadata")
	// ErrSlice describes an invalid or out-of-bounds slice request.
	ErrSlice = errors.New("cdf: invalid slice")
	// ErrOverflow indicates an integer overflow while computing sizes or
	// physical offsets.
	ErrOverflow = errors.New("cdf: integer overflow")
	// ErrOverlap indicates that two variable data regions overlap, or that a
	// begin offset falls inside another variable's data region.
	ErrOverlap = errors.New("cdf: variable region overlap")
	// ErrLayout indicates that the record-variable slab layout or vsize does
	// not match the metadata.
	ErrLayout = errors.New("cdf: inconsistent record slab layout")
	// ErrLimit indicates that the caller's per-read byte limit is unusable.
	ErrLimit = errors.New("cdf: invalid read byte limit")
	// ErrShortRead indicates that io.ReaderAt returned fewer bytes than asked.
	ErrShortRead = errors.New("cdf: short read")
)
