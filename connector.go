package dataeng

import (
	"context"
	"errors"
	"fmt"
)

// SnapshotFunc performs a full snapshot. It receives the plan that detected
// the snapshot condition (initial state or retention gap) and must return the
// LSN from which incremental CDC may resume. The returned LSN is stored as
// the new watermark; the connector never substitutes max_lsn automatically.
type SnapshotFunc func(ctx context.Context, plan Plan) (LSN, error)

// ChangeHandler applies a polled batch after it has been combined but before
// the checkpoint is persisted.
type ChangeHandler func(ctx context.Context, batch Batch) error

// Connector ties an SQLReader and a StateStore together. It reports gaps and
// invokes SnapshotFunc when a new snapshot is required.
type Connector struct {
	Reader      *SQLReader
	Store       StateStore
	ColumnOrder []string
	Snapshot    SnapshotFunc
	Handle      ChangeHandler
}

// Poll performs one snapshot/incremental cycle. A checkpoint is saved only
// after the optional handler succeeds and the whole planned interval has been
// consumed.
func (c *Connector) Poll(ctx context.Context) (Batch, error) {
	if c.Reader == nil {
		return Batch{}, fmt.Errorf("sqlserver cdc: connector has no reader")
	}
	if c.Store == nil {
		return Batch{}, fmt.Errorf("sqlserver cdc: connector has no state store")
	}

	state, err := c.Store.Load(ctx)
	if err != nil && !errors.Is(err, ErrNoState) {
		return Batch{}, fmt.Errorf("sqlserver cdc: load state: %w", err)
	}
	if errors.Is(err, ErrNoState) {
		state = State{}
	}

	batch, err := c.Reader.ReadBatch(ctx, state, c.ColumnOrder)
	if err != nil {
		if !errors.Is(err, ErrSnapshotRequired) {
			return batch, err
		}
		if c.Snapshot == nil {
			return batch, err
		}
		snapshotLSN, snapshotErr := c.Snapshot(ctx, batch.Plan)
		if snapshotErr != nil {
			return batch, fmt.Errorf("sqlserver cdc: snapshot: %w", snapshotErr)
		}
		if snapshotLSN.IsZero() {
			return batch, fmt.Errorf("sqlserver cdc: snapshot returned an empty LSN")
		}
		state.ResetToSnapshot(snapshotLSN)
		if err := c.Store.Save(ctx, state); err != nil {
			return batch, fmt.Errorf("sqlserver cdc: save snapshot state: %w", err)
		}
		return batch, nil
	}
	if batch.Plan.Action != ActionQuery {
		return batch, nil
	}

	if c.Handle != nil {
		if err := c.Handle(ctx, batch); err != nil {
			return batch, fmt.Errorf("sqlserver cdc: apply changes: %w", err)
		}
	}
	for _, change := range batch.Changes {
		state.ObservePosition(change.Position())
	}
	state.CompleteThrough(batch.Plan.Range.ToLSN)
	if err := c.Store.Save(ctx, state); err != nil {
		return batch, fmt.Errorf("sqlserver cdc: save state: %w", err)
	}
	return batch, nil
}
