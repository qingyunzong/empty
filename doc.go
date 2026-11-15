// Package dataeng plans stable, non-overlapping primary-key ranges for
// full-table extraction.
//
// A Plan partitions the complete key space into half-open chunks
// [lower, upper). Boundaries are actual primary-key tuples sampled from one
// repeatable snapshot; the same snapshot is retained for chunk reads. The
// comparison model supports composite keys, per-column direction, explicit
// NULLS FIRST/LAST placement and string collations.
//
// Tables without a primary key return ErrNoPrimaryKey. There is deliberately
// no LIMIT/OFFSET fallback: offset pagination is unstable when rows change and
// cannot provide the no-gap/no-overlap guarantee.
package dataeng
