// Package dataeng compacts overlapping list views into standard
// contiguous-offset list columns for data ingestion hosts. Rows of a
// ListView reference (possibly overlapping or out-of-order) ranges of a
// shared child array; Compact copies the values of valid rows in row
// order, preserves null and empty lists, reports the original position
// of every output child value, and supports list-view children up to
// MaxDepth levels of nesting.
package dataeng
