package virtualarray

import "errors"

// Configuration and validation errors returned while building a virtual
// array. Read errors from the host callback are returned wrapped alongside
// these sentinels where appropriate.
var (
	// ErrInvalidShape means a shape is empty, has the wrong rank, contains a
	// negative length or exceeds the rank limit of 8.
	ErrInvalidShape = errors.New("virtualarray: invalid shape")
	// ErrInvalidSelection means a selection rank does not match its array,
	// a parameter is missing or non-positive/negative, stride < block, a
	// coordinate leaves the shape, or start exceeds the dimension length.
	ErrInvalidSelection = errors.New("virtualarray: invalid selection")
	// ErrInvalidMapping means a mapping source/order is unknown or its
	// virtual and source selections do not select exactly the same number
	// of points.
	ErrInvalidMapping = errors.New("virtualarray: invalid mapping")
	// ErrInvalidRect means a read rectangle is malformed or out of bounds.
	ErrInvalidRect = errors.New("virtualarray: invalid read rectangle")
	// ErrBudgetExceeded means the requested point count is larger than the
	// caller-supplied budget. It is returned before any allocation or source
	// callback runs.
	ErrBudgetExceeded = errors.New("virtualarray: output point budget exceeded")
	// ErrSourceRead means a host read callback failed or returned a batch
	// whose length does not match the requested spans.
	ErrSourceRead = errors.New("virtualarray: source read failed")
)
