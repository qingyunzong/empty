// Package dataeng provides a directly integrable incremental state component
// for an IMAP mail archiving connector.
//
// The component coordinates four related pieces of IMAP state:
//
//   - UIDVALIDITY: a change starts a new mailbox generation and invalidates
//     all older snapshots.
//   - UID: the identity of a message record within one generation.
//   - MODSEQ: CONDSTORE/QRESYNC modification sequence, tracked both per
//     message and as a recovery-point watermark.
//   - VANISHED: expunges, applied only within the snapshot they belong to.
//
// QRESYNC responses are revision-bound. A response is applied only to the
// exact request snapshot; a stale response is rejected without modifying any
// message or recovery point. Message-ID is metadata, never identity: moving
// or copying a message creates a new record under its new UID.
//
// Recovery points and message mutations are committed through one atomic
// Store.Commit call. MemoryStore is a reference implementation; production
// stores should map Commit to one database transaction.
package dataeng
