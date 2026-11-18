// Package formal provides exact, auditable cost allocation for FinOps billing
// pipelines.
//
// Resources form a tag-inheriting hierarchy. Direct charges follow a resource's
// inherited entity tag; shared charges are divided by explicit public weights;
// savings are subtracted from recipients. Every charge is conserved to the
// micro-unit, using deterministic largest-remainder rounding. Missing entity
// tags are never guessed: they are assigned to a configurable, controlled
// unallocated entity.
package formal
