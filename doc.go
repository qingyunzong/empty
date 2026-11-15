// Package dataeng merges CDC delete+insert pairs into primary-key migrations.
//
// A key migration is inferred only when the evidence is local to one
// transaction and one table schema generation:
//
//   - one delete before image and one insert after image must belong to the
//     same transaction, table and schema generation;
//   - every supplied non-key column must be present in both images and have
//     the same value, with at least one such column required;
//   - the pairing must be unambiguous. If several delete/insert candidates
//     share the same evidence, no pair is inferred.
//
// Changes from different transactions are never paired. A migration target
// key that already exists in the transaction's starting state, or that was
// already produced by an earlier change in the same transaction, rejects the
// whole transaction with ErrUniqueViolation. Uniqueness is a table property:
// the same key columns and values collide even across schema generations.
//
// Migration IDs are derived deterministically from the transaction identity
// and schema-scoped old/new keys. Applying the same transaction again returns
// the cached result, so recovery replay preserves the original migration IDs.
// Snapshot and Restore persist that replay ledger.
package dataeng
