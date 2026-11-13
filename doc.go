// Package dataeng provides a small, database-agnostic high-watermark
// primitive for auto-increment keyset collectors.
//
// A Snapshot fixes an inclusive maximum key when the snapshot generation
// starts. Chunks produced from that snapshot never cross the fixed ceiling,
// so rows inserted after the snapshot begins are left for the next
// generation.
//
// Chunks describe complete key intervals, not row counts. A scanner may
// therefore commit a whole interval even when it contains zero rows. Deleted
// rows leave holes, but holes never stall a scan.
//
// MAX(id) by itself is not a completeness proof. A manually inserted key below
// the ceiling is invisible to MAX(id), and a wrapped key allocator can reuse
// low keys. Attach a ChangeLogPosition and reconcile those changes; MaxWatch
// and KeyGuard make that requirement explicit instead of guessing from MAX.
package dataeng
