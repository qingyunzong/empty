// Package dataeng provides an importable, immutable row-visibility index for
// data-lake scanners that read positional and equality delete files.
//
// BuildDeleteIndex validates the complete delete set before scanning and
// copies everything it retains, so callers may reuse or mutate their input
// slices afterwards. Position deletes match data file ID and row number.
// Equality deletes compare the configured key column by value, including NULL
// equality, and apply only when the row's data sequence number is strictly
// less than the delete's sequence number. Scan returns the first applicable
// delete evidence per row, ordered by delete sequence number and then delete
// file ID.
package dataeng
