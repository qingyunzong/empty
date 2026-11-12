package dataeng

import (
	"errors"
	"fmt"
)

var (
	// ErrTruncated reports input ending before the declared object is complete.
	ErrTruncated = errors.New("truncated geometry data")
	// ErrTrailingData reports bytes left after the single top-level object.
	ErrTrailingData = errors.New("trailing geometry data")
	// ErrInvalidByteOrder reports a marker other than 0 or 1.
	ErrInvalidByteOrder = errors.New("invalid byte order marker")
	// ErrInvalidType reports an object type other than 1, 2, 3, or 7.
	ErrInvalidType = errors.New("invalid geometry type")
	// ErrPointLimit reports that the total point budget would be exceeded.
	ErrPointLimit = errors.New("point limit exceeded")
	// ErrDepthLimit reports that collection nesting is too deep.
	ErrDepthLimit = errors.New("geometry depth limit exceeded")
	// ErrNonFiniteCoordinate reports a NaN or infinite X or Y coordinate.
	ErrNonFiniteCoordinate = errors.New("non-finite coordinate")
	// ErrInvalidRing reports a ring with fewer than four points.
	ErrInvalidRing = errors.New("polygon ring has fewer than four points")
	// ErrRingNotClosed reports a ring whose first and last coordinates differ.
	ErrRingNotClosed = errors.New("polygon ring is not closed")
)

// DecodeError identifies a failed geometry and its position in the input.
// Path is a JSONPath-like location such as "$.geometries[2].rings[1]".
// Offset is the absolute byte offset at which the problem was detected.
type DecodeError struct {
	Path   string
	Offset int
	Msg    string
	Err    error
}

func (e *DecodeError) Error() string {
	if e.Msg == "" {
		return fmt.Sprintf("dataeng: %s: %v (byte %d)", e.Path, e.Err, e.Offset)
	}
	return fmt.Sprintf("dataeng: %s: %s (byte %d)", e.Path, e.Msg, e.Offset)
}

func (e *DecodeError) Unwrap() error {
	return e.Err
}

func decodeError(path string, offset int, err error, format string, args ...any) *DecodeError {
	return &DecodeError{
		Path:   path,
		Offset: offset,
		Msg:    fmt.Sprintf(format, args...),
		Err:    err,
	}
}

// Limits bounds a decode. A non-positive field selects its default value.
type Limits struct {
	// MaxPoints is the maximum number of coordinate pairs across the whole
	// top-level object, including all nested collection members.
	MaxPoints int
	// MaxDepth is the maximum collection nesting depth. The top-level object
	// has depth 0 and each nested collection member has depth one greater than
	// its parent.
	MaxDepth int
}

const (
	// DefaultMaxPoints is used when Limits.MaxPoints is not positive.
	DefaultMaxPoints = 1_000_000
	// DefaultMaxDepth is used when Limits.MaxDepth is not positive.
	DefaultMaxDepth = 64
)

// DefaultLimits is the limit set used by Decode.
var DefaultLimits = Limits{
	MaxPoints: DefaultMaxPoints,
	MaxDepth:  DefaultMaxDepth,
}

func (l Limits) normalized() Limits {
	if l.MaxPoints <= 0 {
		l.MaxPoints = DefaultMaxPoints
	}
	if l.MaxDepth <= 0 {
		l.MaxDepth = DefaultMaxDepth
	}
	return l
}
