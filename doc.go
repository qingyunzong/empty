// Package dataeng imports tar archives with exact GNU sparse support.
//
// It understands PAX GNU.sparse versions 0.0, 0.1, and 1.0 as well as the
// legacy GNU type-S header and its chained extension headers. Sparse maps are
// validated before use: extents must be ordered, non-overlapping, and wholly
// inside the logical file size. Holes read as zeroes and are skipped rather
// than allocated when the destination supports io.WriteSeeker.
package dataeng
