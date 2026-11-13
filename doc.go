// Package dataeng implements Iceberg manifest merging and scan planning for a
// lakehouse query engine.
//
// The planner resolves snapshot lineage, inherits data and file sequence
// numbers from manifests, and binds position deletes, deletion vectors and
// equality deletes to the data files they can affect.  Partition predicates
// prune data files only; live delete files are retained until applicability can
// be decided from sequence numbers, file scope and partition specs.  A rollback
// uses the selected snapshot's manifest list and a sequence limit, so delete
// files created by descendant snapshots are never reused.
//
// ReferenceTable and ApplyReferenceDeletes provide a deliberately simple,
// row-by-row oracle for small tables.  VerifyPlan compares that oracle with the
// delete files attached by a planner.
package dataeng
