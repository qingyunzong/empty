// Package dataeng provides joint CSV dialect inference and locked-batch
// conformance checks.
//
// Infer examines all supplied samples together and ranks delimiter, quote,
// escape, newline and encoding hypotheses. Each candidate exposes numeric score
// components and human-readable reasons. A width-stable parse with broken quote
// structure is explicitly prevented from outranking a valid quoted parse.
//
// When the samples do not support one answer, Result.Ambiguous is true and
// Result.Ambiguities contains the operationally distinct near-ties. Callers
// should not guess in that case.
//
// Result.Lock publishes an immutable dialect. Lock.Validate and the Batch and
// Collector helpers quarantine non-conforming files; they never re-infer or
// mutate the batch rule in response to a violation.
package dataeng
