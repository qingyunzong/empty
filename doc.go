// Package dataeng rebuilds nullable list rows from chunked Parquet-style
// repetition/definition levels and a chunked non-null integer value stream.
//
// The fixed schema is a nullable list of nullable int64 elements:
//   - repetition level 0 starts a new row; definition 0 = null list,
//     1 = empty list, 2 = list with one null element, 3 = list with one
//     non-null element;
//   - repetition level 1 continues the current non-null list; definition 2
//     appends a null element and definition 3 appends a non-null element;
//   - only definition 3 consumes one value from the value stream.
//
// Both streams are appended independently in caller order and sealed
// explicitly. Reconstruction pauses while a definition-3 value is in flight,
// and fails on missing values, extra values, illegal continuations or
// truncated streams. Complete rows are staged into a transaction; the
// transaction commits only after both streams are sealed and all validation
// passes. A commit whose outcome is unknown (see ErrCommitUnknown) moves the
// rebuilder to StateNeedsConfirmation and is never retried.
package dataeng
