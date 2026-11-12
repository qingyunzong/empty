package mergejoin

import "context"

// Side identifies one of the two join inputs.
type Side uint8

const (
	// Left is the left join input.
	Left Side = iota
	// Right is the right join input.
	Right
)

// String returns "left" or "right".
func (s Side) String() string {
	switch s {
	case Left:
		return "left"
	case Right:
		return "right"
	default:
		return "unknown"
	}
}

// Row is one input record. IDs are globally unique across both streams;
// Key is the int64 join key and Payload carries the caller's row data.
type Row[P any] struct {
	Key     int64
	ID      uint64
	Payload P
}

// Stream is a paginated input ordered by non-decreasing Row.Key. Pages must
// be returned in order and every page must itself be non-decreasing by key.
// NextPage returns io.EOF once the stream is exhausted; empty pages are
// tolerated. Close releases the underlying input resource.
type Stream[P any] interface {
	NextPage(ctx context.Context) ([]Row[P], error)
	Close() error
}

// Decision tells the Joiner what to do after an emitted pair was accepted.
type Decision int

const (
	// Proceed acknowledges the pair and continues with the next one.
	Proceed Decision = iota
	// Pause acknowledges the pair and blocks processing until Gate.Resume.
	Pause
)

// Pair is one join result: a left row and a right row sharing Key.
type Pair[L, R any] struct {
	Key   int64
	Left  Row[L]
	Right Row[R]
}

// EmitFunc receives one result pair. A nil error acknowledges the pair in
// both decisions: returning Pause only asks the Joiner to block before
// producing the next pair. A non-nil error aborts the run.
type EmitFunc[L, R any] func(ctx context.Context, pair Pair[L, R]) (Decision, error)

// Sizer estimates the in-memory size of one row, in bytes.
type Sizer[P any] func(row Row[P]) int

// Config bounds the rows retained in memory for a single key on one side.
// A group that crosses a budget is spilled to Staging and replayed in
// chunks. Zero values mean the corresponding limit is not enforced.
type Config[L, R any] struct {
	// MaxGroupRows limits the number of rows buffered per key and side.
	MaxGroupRows int
	// MaxGroupBytes limits the estimated byte size buffered per key and
	// side. When set, both sizers must be provided.
	MaxGroupBytes int64
	// LeftSizer estimates left-row sizes; required with MaxGroupBytes.
	LeftSizer Sizer[L]
	// RightSizer estimates right-row sizes; required with MaxGroupBytes.
	RightSizer Sizer[R]
}
