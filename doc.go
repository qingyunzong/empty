// Package dataeng implements a lazy, row-oriented IF-chain evaluator for
// columnar callers.
//
// Callers inject predicates and value expressions. Evaluate applies the
// branches in order to a sparse set of row numbers, evaluating each predicate
// only for rows that are still unresolved and each value only for rows the
// predicate selected. NULL predicates count as false. A predicate or value
// error finalizes only its own row, preserving the input row order and keeping
// failed rows out of every later branch. Result.Accesses reports the exact
// rows visited by each expression occurrence.
package dataeng
