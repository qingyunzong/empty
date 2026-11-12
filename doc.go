// Package dataeng projects allele-indexed genotype data when a host pipeline
// reorders, merges, or drops alleles. It only manipulates the index and
// probability representations defined by the data contract and performs no
// biological interpretation.
//
// Genotype tuples are non-decreasing allele-index sequences of length P,
// ranked by the combinatorial number system
//
//	rank(a1..aP) = sum(i=1..P) C(ai+i-1, i)
//
// so the full vector has length C(N+P-1, P). Rank and Unrank use math/big
// exclusively: they are exact beyond 2^53, never convert to float, and never
// enumerate the combination space.
//
// NewTransform validates a closed source-to-target mapping. ConvertVector
// projects an optional complete rational probability vector under a caller
// combination budget, distinguishing missing, defined, and undefined (zero
// retained mass) outputs. ConvertGT rewrites GT strings while preserving
// field order and the original '/' or '|' separators.
package dataeng
