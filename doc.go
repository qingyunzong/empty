// Package dataeng partitions an ordered sequence of web-extraction nodes into
// record segments.
//
// The caller supplies node feature strings in document order, a set of
// candidate non-empty half-open node-index intervals [Start, End) with
// non-negative profits, and anchor node indices that must be covered.
// BestPartition selects non-overlapping candidates (touching is allowed) that
// cover every anchor exactly once and maximize total profit. Ties are broken
// by fewer selected records and then by the lexicographically smallest list
// of (start, end) pairs in document order.
//
// Coverage constraints are enforced inside the dynamic program rather than by
// filtering the unconstrained interval-scheduling optimum. With at most 200
// candidates and 20 anchors the program runs in O(m^2) transitions with
// O(log a) anchor range checks per transition.
package dataeng
