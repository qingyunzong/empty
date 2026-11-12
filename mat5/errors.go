package mat5

import "errors"

// Sentinel errors returned by the parser. Use errors.Is to match them.
var (
	// ErrTruncated means the input ended before an element or its padding was complete.
	ErrTruncated = errors.New("mat5: truncated input")
	// ErrBadElement means an element violated the closed subset layout.
	ErrBadElement = errors.New("mat5: malformed element")
	// ErrBadType means an element type tag was unknown or appeared in the wrong place.
	ErrBadType = errors.New("mat5: unsupported or unexpected element type")
	// ErrClass means the array class did not match its payload element types.
	ErrClass = errors.New("mat5: class/type mismatch")
	// ErrName means a variable or cell-child name violated the naming rules.
	ErrName = errors.New("mat5: invalid variable name")
	// ErrLimits means one of the host-supplied resource budgets was exceeded.
	ErrLimits = errors.New("mat5: host resource limit exceeded")
	// ErrInflate means a zlib stream was corrupt, truncated, concatenated or oversized.
	ErrInflate = errors.New("mat5: invalid zlib payload")
	// ErrIndex means a cell chain or numeric coordinate was out of range.
	ErrIndex = errors.New("mat5: index out of range")
)
