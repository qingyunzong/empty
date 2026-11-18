// Package formal implements erasure-coded object storage primitives.
//
// A Codec splits a stripe into k data shards and m parity shards using a
// systematic Reed-Solomon code over GF(2^8).  Any k shards, data or parity,
// reconstruct the stripe exactly.  A Cluster stores one shard per node,
// enforces write/read quorums, and serves degraded reads by reconstructing
// missing shards.
//
// Every fragment carries a monotonic version.  Readers only use fragments
// from the committed version they are serving; uncommitted versions and late
// stale responses are ignored rather than mixed into a reconstruction.
package formal
