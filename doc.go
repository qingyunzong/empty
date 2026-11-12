// Package dataeng provides exact record pairing for deduplication.
//
// Match solves a maximum-cardinality, minimum-cost bipartite matching
// problem. Candidate edges are supplied by the caller and may be sparse.
// Left and right record IDs are compared lexicographically by their UTF-8
// bytes. Among equally good matchings, the one whose right-ID sequence (in
// ascending left-ID order) is lexicographically smallest is returned.
package dataeng
