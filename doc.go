// Package formal implements commit-time serializable snapshot isolation (SSI)
// checks for a database transaction manager.
//
// The package does not store tuple versions. It tracks the metadata needed by
// an MVCC commit path: the snapshot at which each transaction started, its
// reads and writes, overlapping transactions, and read-write antidependencies.
// A commit either succeeds, is rejected as a write-write or serialization
// failure, or deterministically dooms another active transaction.
package formal
