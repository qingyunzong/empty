package dataeng

import (
	"errors"
	"fmt"
)

var (
	// ErrMissingShard reports a shard that could not be obtained. It blocks the
	// global watermark but does not invalidate already verified shards.
	ErrMissingShard = errors.New("dataeng: shard unavailable")
	// ErrDigestMismatch reports compressed bytes whose SHA-256 does not match
	// the manifest.
	ErrDigestMismatch = errors.New("dataeng: compressed shard digest mismatch")
	// ErrLineCountMismatch reports decompressed line counts that do not match
	// the manifest.
	ErrLineCountMismatch = errors.New("dataeng: uncompressed line count mismatch")
	// ErrSplitLine reports a shard whose final line is not newline-terminated.
	// A line is never allowed to continue into the next shard.
	ErrSplitLine = errors.New("dataeng: shard boundary splits a line")
	// ErrLineTooLong reports a line larger than the configured limit.
	ErrLineTooLong = errors.New("dataeng: line exceeds maximum size")
	// ErrCorruptShard reports a decompression failure.
	ErrCorruptShard = errors.New("dataeng: corrupt compressed shard")
	// ErrClosed reports use of a closed reader.
	ErrClosed = errors.New("dataeng: reader is closed")
)

// ShardError associates a verification or I/O error with a shard sequence.
type ShardError struct {
	Sequence int64
	Err      error
}

func (e *ShardError) Error() string {
	return fmt.Sprintf("dataeng: shard %d: %v", e.Sequence, e.Err)
}

func (e *ShardError) Unwrap() error { return e.Err }

// MissingShardError reports that the next contiguous shard is unavailable.
// Cause may be nil when the sequence is absent from the manifest.
type MissingShardError struct {
	Sequence int64
	Cause    error
}

func (e *MissingShardError) Error() string {
	if e.Cause == nil {
		return fmt.Sprintf("dataeng: shard %d is missing", e.Sequence)
	}
	return fmt.Sprintf("dataeng: shard %d is missing: %v", e.Sequence, e.Cause)
}

func (e *MissingShardError) Unwrap() []error {
	if e.Cause == nil {
		return []error{ErrMissingShard}
	}
	return []error{ErrMissingShard, e.Cause}
}
