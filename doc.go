// Package dataeng implements a transactional batch reader with read-committed
// visibility over multiple append-only log partitions.
//
// The reader joins partition data batches, transaction control batches
// (COMMIT/ABORT markers), producer ids, producer epochs and per-producer
// sequence numbers. Records that belong to an in-progress transaction are
// buffered until the matching control marker is observed: committed
// transactions are delivered in log order while aborted transactions are
// suppressed and never surface through [Reader.Poll].
//
// The reader tolerates:
//   - batches from partitions arriving in any order,
//   - leader log truncation (offset-out-of-range and epoch regressions),
//   - stale or fenced producer epochs and duplicated/idempotent writes,
//   - process restart: recovery resumes from the persisted checkpoint and the
//     re-emitted record sequence is identical to replaying the log from the
//     beginning by offset order.
package dataeng
