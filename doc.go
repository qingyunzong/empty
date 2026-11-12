// Package dataeng provides an incremental builder for minimal acyclic
// deterministic additive transducers over arbitrary byte keys, together with
// read-only Lookup, Rank, and Select queries on the frozen graph.
//
// Keys are supplied in strictly increasing unsigned-byte lexicographic order.
// Every closed suffix is canonicalized immediately, and only the prefix path
// of the most recently added key remains mutable. Values are carried as
// non-negative uint64 edge and terminal outputs; the root additionally has an
// initial output equal to the dictionary minimum.
package dataeng
