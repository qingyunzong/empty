// Package dataeng computes exact cardinality-counting polynomials and
// Shapley contributions for validated Boolean lineage DAGs.
//
// All counts use math/big integers and all contributions use math/big
// rationals. The algorithm never enumerates subsets or permutations: AND
// nodes convolve disjoint-support polynomials, DECIDE nodes pad branch
// polynomials for free variables absent from a branch, and root polynomials
// are padded for facts outside the root's structural support.
package dataeng
