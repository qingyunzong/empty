// Package dataeng implements a fixed-cell invertible Bloom lookup table
// (IBLT) for locating set differences between two uint64 identifier sets.
//
// A Table contains only a fixed number of cells. Each cell holds an arbitrary
// precision signed count and two uint64 XOR accumulators. The package does not
// transmit the original sets. A host-provided deterministic hash function maps
// every identifier to k distinct cell indices and a 64-bit check value.
//
// Peeling a difference table produces candidate identifiers with a direction.
// A completely peeled digest is not a proof that the input sets are equal:
// finite check values can collide, and XOR summaries can cancel. Equality is
// established only by VerifySets (or PeelResult.Verify), which compares the
// recovered difference against complete snapshots of both input sets.
package dataeng
