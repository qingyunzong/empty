// Package dataeng merges MongoDB change stream events that are read from
// several shards into one deterministic, resumable sequence.
//
// A Merger accepts events in any order, orders them by cluster time, shard,
// resume token and transaction identity, removes duplicates produced while
// chunks migrate, and reports a watermark that never moves past the slowest
// active shard. An
// invalidate event closes the generation in which it occurs, so events from the
// closed generation can never leak into the new one.
//
// The package has no MongoDB driver dependency. Callers convert driver events
// into Event values and keep the original resume token as an opaque string.
package dataeng
