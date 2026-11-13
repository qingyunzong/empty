// Package dataeng implements entity clustering with hard must-link and
// cannot-link constraints plus scored candidate merge edges.
//
// The clustering is greedy: candidate edges are considered in descending score
// order, ties are broken by a public canonical TieKey, and an edge is accepted
// only when merging its components does not violate the cannot-link closure.
// Rejected edges include a minimum-length conflict path that identifies the
// exact must-link/merge chain and cannot-link that prevent the merge.
package dataeng
