// Package formal implements a durable two-phase commit coordinator for stream
// processing sink operators.
//
// A transaction moves through Begin, Prepare, and Commit (or Abort). Prepare
// fsyncs the complete payload and leaves the transaction in flight. Commit
// fsyncs a commit frame, which is the commit point. Only after that frame is
// durable does the transaction enter the committed view; prepared and open
// records are never returned by Committed or CommittedRecords.
//
// The commit log is a CRC-framed append-only file. Replay ignores a torn final
// frame, restores prepared transactions as in-flight, restores committed
// transactions and their stable receipts, and completes any committed delivery
// whose acknowledgement is missing. Repeating Commit for a committed
// transaction returns the original receipt and does not deliver records twice.
//
// A Sink must make Apply idempotent for TxnID (and CommitSeq). Recovery can
// re-deliver after a crash that happened between the external effect and the
// durable acknowledgement. MemorySink is an idempotent reference
// implementation.
//
// Applications that need sink-level exactly-once output should give each
// Record a non-empty ID. IDs are unique within a transaction and across all
// committed transactions; attempting to commit an ID owned by another
// transaction returns ErrRecordConflict.
//
// Crash injection is available through WithCheckpoint and AllCrashPoints for
// enumerating durable and visibility boundaries in tests.
package formal
