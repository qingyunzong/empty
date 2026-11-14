package dataeng

import (
	"context"
	"fmt"
	"io"
)

// SnapshotReader yields full tuples visible in the exported snapshot. Next
// returns io.EOF after the last row. Implementations should read inside the
// exported snapshot transaction.
type SnapshotReader interface {
	Next(ctx context.Context) (SnapshotRow, error)
	Close() error
}

// SnapshotSource opens a consistent initial-copy scan using the exported
// snapshot. The same Snapshot binding (including its ConsistentPoint and
// relation versions) is passed to every adapter.
type SnapshotSource interface {
	OpenSnapshot(ctx context.Context, snapshot Snapshot) (SnapshotReader, error)
}

// WALReader yields committed logical changes in ascending unique LSN order.
// Next returns io.EOF when the stream ends.
type WALReader interface {
	Next(ctx context.Context) (Change, error)
	Close() error
}

// WALSource opens a logical decoding stream starting at from. The coordinator
// skips records at or below its durable flush LSN, so a source may safely
// replay inclusively.
type WALSource interface {
	OpenWAL(ctx context.Context, from LSN) (WALReader, error)
}

// SnapshotSourceFunc adapts a function to SnapshotSource.
type SnapshotSourceFunc func(ctx context.Context, snapshot Snapshot) (SnapshotReader, error)

// OpenSnapshot implements SnapshotSource.
func (f SnapshotSourceFunc) OpenSnapshot(ctx context.Context, snapshot Snapshot) (SnapshotReader, error) {
	if f == nil {
		return nil, fmt.Errorf("%w: nil snapshot source", ErrInvalidConfig)
	}
	return f(ctx, snapshot)
}

// WALSourceFunc adapts a function to WALSource.
type WALSourceFunc func(ctx context.Context, from LSN) (WALReader, error)

// OpenWAL implements WALSource.
func (f WALSourceFunc) OpenWAL(ctx context.Context, from LSN) (WALReader, error) {
	if f == nil {
		return nil, fmt.Errorf("%w: nil WAL source", ErrInvalidConfig)
	}
	return f(ctx, from)
}

type staticSnapshotSource struct {
	rows []SnapshotRow
}

// NewStaticSnapshotSource returns a SnapshotSource that replays rows in order.
// It is intended for tests and for adapters that have already materialized the
// initial copy.
func NewStaticSnapshotSource(rows []SnapshotRow) SnapshotSource {
	copied := make([]SnapshotRow, len(rows))
	for i, row := range rows {
		copied[i] = row.Clone()
	}
	return &staticSnapshotSource{rows: copied}
}

func (s *staticSnapshotSource) OpenSnapshot(ctx context.Context, _ Snapshot) (SnapshotReader, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return &staticSnapshotReader{rows: s.rows}, nil
}

type staticSnapshotReader struct {
	rows  []SnapshotRow
	index int
}

func (r *staticSnapshotReader) Next(ctx context.Context) (SnapshotRow, error) {
	if err := ctx.Err(); err != nil {
		return SnapshotRow{}, err
	}
	if r.index >= len(r.rows) {
		return SnapshotRow{}, io.EOF
	}
	row := r.rows[r.index].Clone()
	r.index++
	return row, nil
}

func (r *staticSnapshotReader) Close() error { return nil }

type staticWALSource struct {
	changes []Change
}

// NewStaticWALSource returns a WALSource that replays changes in order. The
// source itself does not filter or reorder; the coordinator validates ordering
// and ignores records at or below its durable flush position.
func NewStaticWALSource(changes []Change) WALSource {
	copied := make([]Change, len(changes))
	for i, change := range changes {
		copied[i] = change.Clone()
	}
	return &staticWALSource{changes: copied}
}

func (s *staticWALSource) OpenWAL(ctx context.Context, _ LSN) (WALReader, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return &staticWALReader{changes: s.changes}, nil
}

type staticWALReader struct {
	changes []Change
	index   int
}

func (r *staticWALReader) Next(ctx context.Context) (Change, error) {
	if err := ctx.Err(); err != nil {
		return Change{}, err
	}
	if r.index >= len(r.changes) {
		return Change{}, io.EOF
	}
	change := r.changes[r.index].Clone()
	r.index++
	return change, nil
}

func (r *staticWALReader) Close() error { return nil }
