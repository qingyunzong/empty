// Package dataeng provides an importable consumer for compressed, sharded
// NDJSON exports.
//
// A Manifest describes the shards that make up one export. Each shard carries
// an ordered sequence number, the SHA-256 digest of its compressed payload, its
// uncompressed line count, and the global schema version of the export.
//
// A Consumer downloads shards concurrently, verifies them, and exposes their
// records in sequence order. Decompression is streamed shard by shard. Shards
// are line-complete: a line must never be assembled from bytes in two different
// shards. A missing shard blocks the reader's watermark until it becomes
// available, while verified shards are kept in an optional Cache and can be
// reused when consumption is resumed.
package dataeng
