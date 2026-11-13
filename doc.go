// Package dataeng implements multiline log event boundaries on top of a
// concurrency-safe aggregation state machine and a growing-file collector.
//
// A Rule supplies start, continue, and timeout predicates. File rotation,
// truncation, encoding failures, and the maximum byte budget each complete an
// open event with a machine-readable reason and cause. Snapshots preserve the
// unfinished event together with its original source offsets.
package dataeng
