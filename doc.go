// Package formal provides an embeddable, concurrency-safe aggregation table for
// service discovery observations.
//
// A discovery client usually receives the same instance state from several
// independent sources: health checks, weight updates, and connection-pool
// drain reports. Those observations can arrive duplicated, out of order, or
// late. The Aggregator folds them into one deterministic instance table.
//
// # Ordering
//
// Every event names an instance, a generation, a revision, and an aspect of
// the instance state (health, weight, drain state, or membership). A larger
// generation denotes a newer incarnation of the instance, so all events from
// an older generation are ignored. Inside one generation, each aspect is
// last-writer-wins by revision. Revision counters are therefore independent
// between aspects and may restart when the generation changes.
//
// Equal revisions are expected to be duplicates. If a producer nevertheless
// emits two different values with the same revision, the merge is still
// deterministic and commutative: the more conservative value wins
// (unhealthy, draining/drained, and removed win ties; the larger weight wins).
//
// # Availability
//
// An instance is live when its membership is present and its drain state is
// not DrainDrained. It is available for new requests only when it is live,
// healthy, not draining, and has a positive weight. Drained and removed
// instances are absent from Snapshot and Available.
//
// New generations start from an unknown health state, the configured default
// weight, and DrainActive. A reconnect must therefore publish a new generation;
// stale observations from the previous connection cannot resurrect it.
package formal
