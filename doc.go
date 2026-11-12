// Package dataeng is an importable predicate compiler for columnar scan
// hosts. A Schema declares nullable int64 or string columns; Compile parses
// and type-checks a SQL-like predicate and Expr.Evaluate runs the compiled
// predicate directly over dictionary-encoded batches, returning the
// selection bitmap.
//
// # Expression language
//
// Predicates are built from constants, column references, comparisons, and
// boolean connectives:
//
//   - Values: integer literals (e.g. 42), single- or double-quoted string
//     literals (e.g. 'x'), the untyped NULL literal, and column references.
//   - Comparisons: =, <, <= between two values of the same type.
//   - Boolean: AND, OR, NOT and the postfix IS NULL test.
//   - Parentheses group subexpressions; keywords are case-insensitive.
//
// There are no implicit type conversions. Compile rejects unknown columns
// and any comparison whose non-null operands have different types.
//
// # Null semantics
//
// All columns are nullable and the language follows Kleene three-valued
// logic. A comparison with a null operand evaluates to unknown rather than
// true or false. AND is dominated by false, OR is dominated by true, NOT
// preserves unknown, and the filter keeps only rows whose final result is
// true (false and unknown rows are both excluded).
//
// # Batches
//
// A Batch holds one dictionary-encoded column per schema column. Index -1
// marks a null row; every other index references the column dictionary,
// which may contain duplicate values. Evaluate validates the entire batch
// before evaluating anything: row count must be non-negative, every schema
// column must be present with the declared type, and each column must carry
// exactly RowCount indices in range. Malformed batches are rejected whole
// via errors wrapping ErrInvalidBatch, including columns the predicate does
// not reference, so evaluation short-circuits cannot skip the checks.
//
// Compiled Expr values are immutable and safe for concurrent reuse; each
// Evaluate call allocates its own working state.
package dataeng
