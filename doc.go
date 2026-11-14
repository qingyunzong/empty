// Package dataeng implements Pulsar batch acknowledgement state.
//
// A Tracker combines ledger, entry and batch-index coordinates with individual
// and cumulative acknowledgements. It also keeps a separate output-commit
// ledger so a redelivered batch can publish only indexes whose output does not
// exist yet. Topic unloads and subscription generation changes invalidate old
// acknowledgements; committed output remains deduplicated. The whole state can
// be snapshotted and restored exactly.
package dataeng
