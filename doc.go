// Package dataeng implements a sparse observation matrix ingestor for
// telemetry collection.
//
// Events arrive in batches. Each batch carries a monotonically increasing
// version starting at 1 and a list of events. Batches may be submitted out of
// order; batches whose predecessor has not been observed yet are buffered
// until the gap closes. The total retained size of buffered batches is bounded
// by a caller-supplied byte budget.
//
// Within one batch, multiple events may target the same cell. The effective
// operation for the cell is the event with the lexicographically greatest
// event ID (event IDs compared as raw byte sequences); values are never summed.
// An event may explicitly delete a cell. Deletion is distinct from storing the
// numeric value zero: a zero value remains present in the canonical CSR output
// until an explicit delete removes it.
//
// Every committed version yields a canonical compressed sparse row (CSR)
// representation together with the originating event ID for every retained
// cell. Re-submitting an already committed version is only accepted when the
// re-submitted batch is byte-for-byte equivalent to the original one.
package dataeng
