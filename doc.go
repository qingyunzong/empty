// Package dataeng provides snapshot-aware compaction for versioned LSM data.
//
// Records are ordered by ascending key and, within a key, by descending
// version. Compact removes every version that is not needed to reproduce the
// result of any of the supplied snapshots while retaining the smallest possible
// subset of the input records.
package dataeng
