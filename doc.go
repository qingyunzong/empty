// Package dataeng provides an importable compaction state component for a data
// lake maintenance service.
//
// A Manager owns the active manifest, the append-only snapshot history, the
// compaction plan registry and the safe-to-recycle list. It is safe for
// concurrent use.
//
// The component enforces four guarantees:
//
//   - Selection isolation: PlanCompaction only picks active files from one
//     partition that are not already claimed by another open plan.
//   - Snapshot anchoring: every plan records the snapshot id it was planned
//     against (BaseSnapshotID).
//   - Optimistic concurrency: Commit re-validates that all inputs are still
//     active. When two intersecting compactions race, only the first commits;
//     the loser gets ErrConflict with no state change and stays open for retry.
//   - Safe recycling: replaced inputs are queued as snapshot-bound recycle
//     items, while outputs of a failed job never enter the manifest and are
//     queued as immediately reclaimable items via Fail.
package dataeng
