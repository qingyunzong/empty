// Package formal implements an embeddable, durable transaction state machine
// for transactional messages.
//
// The coordinator sits between a message store and a business transaction. It
// coordinates four operations:
//
//   - Prepare durably stores a half message. The message is not deliverable.
//   - Commit makes exactly one transaction generation deliverable.
//   - Rollback makes the generation permanently invisible.
//   - Due and MarkChecked drive timeout re-queries when the business outcome is
//     not known yet.
//
// # Generations
//
// A Ref is a transaction number (ID) plus a generation. Every successful
// prepare allocates a strictly larger generation. Callers may reuse an ID only
// after its current generation is final; an unresolved ID accepts a retry only
// for an identical message and otherwise returns InFlightError.
//
// Confirmations carry the full Ref. A late confirmation for an older generation
// therefore resolves that older generation (or fails with ErrStaleGeneration if
// its attempt is no longer known) and can never be applied to the newer
// attempt that reused the ID.
//
// # Final decisions
//
// Commit and Rollback are final and idempotent. Once a generation is final,
// every later confirmation returns the stored decision with Decision.Duplicate
// set. A request for the opposite outcome returns the stored outcome with
// Decision.Conflict set; it does not append a new record and does not change
// visibility.
//
// # Durability and replay
//
// Every transition is encoded as a JSON record in a length- and CRC-framed
// append-only log. A transition is applied in memory only after Store.Append
// reports that the complete frame is durable. On Open, the longest valid prefix
// is replayed and an incomplete tail is truncated.
//
// Replay derives the deliverable set from commit records, keyed by Ref. A
// transaction generation is therefore either absent from that set or present
// exactly once, including when a commit record was copied or an ambiguous
// append was retried. The same rule is exercised by the crash-point enumeration
// tests, which truncate the log at every byte of every record and replay it.
//
// This is exactly-once membership in the deliverable set. Handing messages to
// consumers still needs its own acknowledgement and idempotency protocol; that
// is deliberately outside this component.
//
// # Scheduling checks
//
// A prepared attempt keeps its durable deadline and check count. Due returns
// attempts whose deadline or re-check interval has elapsed. MarkChecked records
// one re-query without deciding anything. The caller asks the business for its
// local outcome and then calls Commit or Rollback. CheckRequest.Exhausted
// reports when WithMaxChecks has been reached, but the coordinator never makes
// a business decision on the caller's behalf.
//
// # Embedding
//
// MemoryStore is suitable for tests and non-durable embedding. FileStore
// provides an fsync-on-append file log. A custom Store only has to provide
// durable prefix appends, full reads, and truncation. One coordinator should
// own one store. Options that affect scheduling (WithRecheckInterval,
// WithMaxChecks, WithDefaultTimeout) should be supplied again when reopening a
// log.
package formal
