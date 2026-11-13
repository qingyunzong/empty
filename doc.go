// Package dataeng provides a sort-merge join library for ETL pipelines.
//
// Both inputs are sorted by a composite key and may arrive in chunks.
// Duplicate-key groups that exceed a memory bound spill to disk under a
// transaction: cancelling the join removes only the in-flight transaction's
// spill files, while committed batches are kept. Spill readers track byte
// offsets so consumers can resume mid-file. Regular (NULL-rejecting) and
// null-safe equality are separate join modes.
package dataeng
