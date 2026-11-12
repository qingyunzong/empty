package mergejoin

import "errors"

// Sentinel errors returned by the package.
var (
	// ErrInvalidConfig is returned when a Joiner or Config is invalid.
	ErrInvalidConfig = errors.New("mergejoin: invalid configuration")

	// ErrUnsorted is returned when an input stream violates the
	// non-decreasing key ordering contract.
	ErrUnsorted = errors.New("mergejoin: input stream is not sorted by key")

	// ErrTruncated is returned when a staged key group cannot be replayed
	// in full, so the observed output is smaller (or larger) than the
	// required Cartesian product. Rows are never dropped quietly.
	ErrTruncated = errors.New("mergejoin: staged group replay truncated the join")

	// ErrClosed is returned when a staging handle or one of its
	// writers/readers is used after Close.
	ErrClosed = errors.New("mergejoin: staging handle is closed")

	// ErrStreamClosed is returned by SliceStream.NextPage after Close.
	ErrStreamClosed = errors.New("mergejoin: input stream is closed")

	// ErrRunReused is returned when Joiner.Run is invoked more than once.
	ErrRunReused = errors.New("mergejoin: joiner has already been run")
)
