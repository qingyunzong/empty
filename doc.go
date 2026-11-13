// Package dataeng provides deterministic weighted priority reservoir sampling.
//
// Each record is identified by a unique string ID and a positive weight. Its
// priority is the Efraimidis-Spirakis key U^(1/weight), with U derived from a
// stable SHA-256 hash of the ID. Since U does not depend on insertion order,
// process, shard, or replay count, independently sampled shards can be merged
// and produce exactly the same top K as a single centralized sample.
//
// Equal priorities are ordered by ascending unique ID, which makes boundary
// selection deterministic. Replaying a record with the same ID and weight is a
// no-op, and non-positive or NaN weights are rejected.
package dataeng
