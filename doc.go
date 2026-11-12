// Package dataeng provides an in-memory row-mirror for change capture.
//
// A Table is an immutable snapshot of rows against a fixed Schema. Rows are
// addressed by the schema's single, non-null primary key. A Batch describes
// inserts, updates and deletes against the rows as they existed before the
// batch; applying a valid batch produces a new Table and leaves the original
// snapshot untouched.
//
// Cells distinguish omitted/missing values, an explicit "unchanged" marker,
// SQL NULL, int64 values and byte-string values. This distinction lets update
// after-images be partial while still supporting explicit NULL replacement.
package dataeng
