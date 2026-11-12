// Package dataeng implements a single-stream replay engine for schema,
// dictionary and batch messages.
//
// A stream begins with exactly one schema. Dictionary generations are frozen
// snapshots: a full replacement starts a new snapshot, an append extends its
// predecessor without changing old entries, and batches always decode against
// the generation they explicitly request. Batches may arrive before their
// dictionaries; they wait until the named generations are available. Returned
// batches are independent copies and are never changed by later dictionary
// updates.
//
// See Stream and Replay for the two replay entry points.
package dataeng
