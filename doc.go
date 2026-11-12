// Package dataeng computes canonical polynomial lineage over a shared
// expression DAG.
//
// Base rows are variables. Union is polynomial addition, join is
// multiplication, and repeated sources accumulate coefficients. Expansion is
// canonical, sparse, and uses arbitrary-precision non-negative coefficients.
// Callers may impose a monomial budget; an over-budget expansion returns an
// unclosed BudgetError instead of a truncated polynomial.
package dataeng
