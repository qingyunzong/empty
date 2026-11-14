// Package dataeng implements a crash-recoverable handoff from a PostgreSQL
// exported initial snapshot to logical WAL decoding.
//
// A Coordinator binds four things into one immutable contract: the exported
// snapshot name, its consistent point, the exact relation schema versions
// visible in that snapshot, and the WAL stream that starts at the consistent
// point. Snapshot rows are deduplicated by canonical primary key; WAL changes
// are deduplicated by their unique record LSN.
//
// Every relation version is stored immutably, and each change is resolved with
// the exact RelationVersion it names. A tuple decoded before a DDL is therefore
// never interpreted with a later schema.
//
// Durable progress follows a strict rule: the checkpoint's FlushLSN advances
// only after Sink confirms the corresponding batch. A state file is replaced
// atomically, so recovery always starts from a confirmed position. Sink
// implementations must be idempotent because a crash can occur after the sink
// commits but before the checkpoint is written; the batch is then replayed.
package dataeng
