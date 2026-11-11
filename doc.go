// Package q159 provides an embeddable transformation component for Go
// consumers of a data bus whose field schemas evolve over time.
//
// Schemas are the vertices of a directed acyclic graph; each Edge carries a
// caller-supplied pure transformation and a positive integer cost. A
// Transformer routes each record from the schema it carries to a target
// schema along the minimum-cost path, breaking ties on the lexicographically
// smallest edge ID sequence.
//
// The target schema switches at a barrier via SetTarget. A batch admitted
// before the barrier captures an immutable graph snapshot and the old
// target, so it finishes deterministically while later batches use the new
// target. Graph updates via ReplaceEdges validate the new DAG (rejecting
// cycles atomically) and install a fresh snapshot whose path cache is
// isolated from every older version.
//
// ApplyBatch is all-or-nothing: planning runs before any transformation, a
// record without a route rejects the whole batch without invoking a single
// transform, and a transformation failure rejects the batch with no partial
// output. A Transformer is safe for concurrent use and starts no goroutines
// of its own.
package q159
