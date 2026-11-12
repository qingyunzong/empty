// Package dataeng implements containment and equivalence checks for parsed
// conjunctive queries, together with a set-semantics query interpreter.
//
// Inputs are query structures, not SQL text. Relations have a positive arity;
// terms are query-scoped variables or UTF-8 constants compared byte-for-byte.
// A Problem checks whether A is contained in B: for every finite database D,
// A(D) is a subset of B(D). A proof is a complete mapping of every B variable
// into A's body variables or the constants of either query, with B's body atoms
// matching A's body and B's head matching A's head term by term.
//
// Search is deterministic and budgeted. If the budget is exhausted the result
// is Undecided with an opaque cursor; it is never NotContained. Resuming the
// same input is equivalent to a single run with the summed budget. If the
// search space is exhausted, a typed-fresh-symbol counterexample database is
// generated from A and verified with the package interpreter.
package dataeng
