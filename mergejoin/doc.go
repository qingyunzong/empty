// Package mergejoin implements an inner merge join over two paginated,
// key-sorted input streams.
//
// The two streams are ordered by non-decreasing int64 keys, both across
// pages and inside each page, and a key may appear on multiple rows. For a
// key present on both sides the join emits its Cartesian product in left-row
// order and then right-row order: every left row is paired with every right
// row of the same key. Keys missing on either side produce no pairs.
//
// A single key group can be larger than the configured memory budget. When
// that happens the group is spilled through a caller-provided, replayable
// Staging implementation and processed in chunks without dropping rows; a
// replay that does not yield the full product fails with ErrTruncated
// instead of silently truncating results.
//
// Result pairs are delivered through an emit callback. A nil error
// acknowledges the pair, whether the callback returns Proceed or Pause: a
// Pause decision means the pair has been received and join processing blocks
// until Gate.Resume, without ever re-sending an acknowledged pair.
// Cancelling the context aborts the run and closes both input streams and
// the staging handle.
package mergejoin
