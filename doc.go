// Package dataeng implements soft-deletion detection for a resource collector.
//
// The resource API exposes only a current listing and has a limited call
// quota. A Detector therefore consumes snapshots supplied by the caller. A
// snapshot is a complete generation only when Complete is true, meaning the
// entire current list was retrieved successfully. Error pages, rate-limit
// responses, truncated pages, and parse failures must be reported as
// incomplete; an incomplete snapshot never advances the generation counter
// and never contributes evidence for a deletion.
//
// Old IDs are rechecked on a rotation schedule. Rendezvous hashing (a form of
// consistent hashing) assigns every ID to one of MaxRecheckCycles slots, and
// successive complete generations visit successive slots. Consequently an ID
// is rechecked at least once in every MaxRecheckCycles complete generations,
// even when the set of live IDs changes. A delete event is emitted only after
// an ID is absent from DeleteAfter scheduled rechecks. If a deleted ID appears
// again, a restore event is emitted with a higher version.
package dataeng
