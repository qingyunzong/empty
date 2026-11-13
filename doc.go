// Package dataeng implements a multi-region merge store for global SaaS
// connectors.
//
// Regions contribute Records carrying their own VersionVector, wall-clock
// timestamp and optional tombstone. Merge adjudication uses only the causal
// partial order of version vectors: dominating versions replace older ones
// while concurrent versions are retained as a conflict set for pluggable
// ConflictPolicy resolution. Timestamps are display-only metadata.
//
// Deletions are explicit versioned tombstones; an unreachable region never
// causes data loss. Replay after recovery is idempotent through EventID
// deduplication and equal-vector handling.
package dataeng
