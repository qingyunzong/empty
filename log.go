package formal

import "context"

// Snapshot is a transactionally consistent view of the table at Watermark.
//
// A snapshot at watermark W must contain exactly the effects of transactions
// whose commit Seq is <= W, and no effects of transactions whose commit Seq is
// greater than W. In particular it must not expose a partially committed
// transaction.
type Snapshot interface {
	// Watermark is the commit sequence at which the snapshot was taken.
	Watermark() Seq

	// Scan visits every key in the snapshot exactly once. The order is
	// unspecified; implementations should stop promptly when ctx is done.
	Scan(ctx context.Context, visit func(Key, Value) error) error
}

// SnapshotSource opens transactionally consistent snapshots.
type SnapshotSource interface {
	OpenSnapshot(ctx context.Context) (Snapshot, error)
}

// HistoricalSnapshotSource can open a snapshot at a past commit sequence. It is
// used by auditors to compare an index against the authoritative table state at
// the exact barrier recorded in a certificate.
type HistoricalSnapshotSource interface {
	SnapshotSource
	OpenSnapshotAt(ctx context.Context, at Seq) (Snapshot, error)
}

// ChangeLog is the commit-ordered source of incremental index changes.
//
// Correctness of the handoff depends on this contract:
//
//   - HighWatermark returns a commit sequence V such that every commit with
//     Seq <= V that affects the table is durably readable with Read.
//   - Read(after, through) eventually returns, for the range
//     (after, through], every commit Q that affects the table, with unseen
//     Q.Seq values in increasing order, and with all changes of Q in one Batch
//     entry. Previously delivered commits may be replayed anywhere in a page.
//   - A transaction is assigned its Seq at commit time. A transaction that
//     started before the snapshot watermark but committed after it therefore
//     appears with Seq > watermark, never in the snapshot.
//   - Read is at-least-once: it may replay commits the caller has already
//     applied. Duplicate Seq values must carry identical content.
//   - Done=true is the authoritative statement that the range is exhausted.
//     Callers must not infer exhaustion from a short page.
//
// The coordinator never trusts the log to be gap-free in the numeric sense;
// gaps may represent commits for other tables. It trusts the log to be
// complete for this table.
//
// The snapshot source and change log must describe the same table on the same
// commit timeline. The log must retain commits from the snapshot watermark
// until the build seals.
type ChangeLog interface {
	HighWatermark(ctx context.Context) (Seq, error)
	Read(ctx context.Context, after, through Seq, limit int) (Batch, error)
}
