// Package dataeng computes an exact order-preserving projection (isotonic
// regression) of weighted rational observations onto the feasible cone defined
// by a directed acyclic graph of weak ordering constraints.
//
// Given observations (y_i, w_i) with strictly positive rational weights and
// directed edges u -> v meaning x_u <= x_v, the solver returns the unique
// rational vector x minimizing
//
//	F = sum_i w_i * (x_i - y_i)^2
//
// subject to every edge constraints. All arithmetic uses math/big: there are
// no floating point numbers, epsilon tolerances, or denominator truncations.
//
// The optimization is a general-DAG algorithm built on closed-set minimum cuts
// (maximum flow), not on a chosen topological ordering and not on exhaustive
// enumeration of partitions, orderings, or edge subsets. Each block is refined
// only while a minimum-weight lower-closed subset exists, which strictly grows
// the number of blocks; hence the procedure terminates after finitely many flow
// calls. The result also carries exact non-negative KKT multipliers and the
// number of flow invocations is exposed so callers see real termination
// behavior rather than a fixed iteration budget.
//
// A compiled [Graph] is reusable across many solves with different y and w.
// The independent certificate checker lives in subpackage cert and never runs
// the optimizer: it recomputes feasibility, stationarity, complementarity and
// the objective from the raw inputs.
package dataeng
