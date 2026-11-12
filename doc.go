// Package dataeng compiles and decodes a self-contained BUFR-style descriptor
// subset without external tables or network access.
//
// # Inputs
//
// Descriptors use F/X/Y triples in the supported ranges F=0..3, X=0..63,
// Y=0..255. The caller supplies an element table for F=0, a sequence table for
// F=3, the raw subset count, and an MSB-first bit stream.
//
// F=1 counts X raw descriptor positions, not expanded leaves. A delayed
// replication (Y=0) is followed by exactly one 0-31-001 or 0-31-002 factor
// descriptor; that factor is not part of its own X positions. Nested
// replications consume their factor and body inside an enclosing replication's
// X positions, so a boundary that cuts either one is rejected.
//
// F=2 supports X=1 (width offset) and X=2 (scale offset). Y=0 clears the
// offset; Y=1..255 sets it to Y-128. Operators affect following elements
// globally within the current subset: leaving a sequence or replication does
// not restore offsets, and each new subset starts both offsets at zero.
//
// # Outputs
//
// Decode emits one Observation per selected F=0 occurrence, in execution
// order. It includes the 1-based subset, element identifier, active
// sequence/replication path, zero-based half-open original bit range, and
// either a canonical arbitrary-precision rational or a missing marker.
// Repeated elements are never coalesced.
//
// # Atomicity and budgets
//
// Compile validates every reachable branch, definition, and sequence cycle,
// including branches that will not execute. Effective width is checked only
// when an element actually executes. Decode enforces host budgets for output
// observations, executed descriptors/factor reads, and active nesting depth.
// Any error returns no observations at all.
//
// # Reference expander
//
// The internal/refexp package is an intentionally small, independent
// structural expander used to audit X-position counting and repetition paths.
// It is not used by the production decoder.
package dataeng
