// Package dataeng plans Iceberg position deletes for a lakehouse read layer.
//
// The package is deliberately self-contained: it does not read manifests or
// object stores. Callers supply the data files, delete files, and snapshot graph
// that their reader has already resolved. The planner then applies the
// Iceberg visibility rules:
//
//   - A delete record only applies to a data file with the same canonical path.
//   - A delete file only applies when its sequence number is greater than or
//     equal to the data file's sequence number.
//   - Only delete files visible on the target snapshot's ancestor chain are
//     considered. Sibling branches do not leak into a branch snapshot.
//   - Path canonicalization preserves object identity. It never removes
//     trailing slashes, collapses repeated slashes, resolves dot segments,
//     decodes reserved escapes, or discards query/fragment components.
//
// Planner output is deterministic and grouped by data file. Delete positions
// are coalesced into sorted, half-open intervals [Start, End). A row-by-row
// reference implementation is provided to verify that the interval plan
// produces exactly the same visible rows.
package dataeng
