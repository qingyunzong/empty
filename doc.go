// Package dataeng implements a versioned lineage graph for a data catalog.
//
// Nodes represent assets such as tables, views, jobs, and recursive CTEs.
// Edges are directed in dataflow order: From is upstream and To is downstream.
// Querying upstream from a node follows incoming edges; querying downstream
// follows outgoing edges.
//
// Traversal state is keyed by (node, edge type), not by node alone. A node that
// is reached through a different relationship type is explored again, which
// correctly models graphs where, for example, a view reads one input and writes
// another. Repeating a (node, edge type) state on the current path closes a
// cycle: the walker records the first evidence for that cycle and does not
// recurse through it, so recursive CTEs, self-referencing views, and job cycles
// cannot cause unbounded traversal.
//
// Returning to the query root also closes a cycle immediately: the root has no
// incoming edge type, so any route back to it is a cycle regardless of the
// relationship type used by the closing edge.
//
// Every mutation publishes a new immutable Snapshot. A query loads exactly one
// snapshot, so a concurrent incremental edge update can never make a single
// query observe a mixture of two catalog versions.
package dataeng
