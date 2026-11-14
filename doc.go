// Package dataeng implements an append-only, versioned manifest publisher
// for object stores that expose only Put, Get and List.
//
// A batch is made visible atomically by writing:
//
//   - immutable, content-addressed data objects;
//   - one immutable manifest describing the batch and its parent manifest;
//   - a single mutable HEAD pointer with the manifest digest.
//
// Readers resolve HEAD, verify the pointer and manifest digests, verify the
// parent chain, and then expose a consistent snapshot. Publishers use a
// conditional write (If-Match/If-None-Match semantics) on HEAD. A publisher
// that loses the race re-reads the winning head and rebuilds its manifest
// against that parent; it never overwrites the winner's pointer with a
// stale-parent manifest.
package dataeng
