// Package dataeng discovers exact functional dependencies in finite
// relations for a data-quality validation service.
//
// A relation is a slice of rows, each row a slice of *string cells. A nil
// cell represents null; null is a distinct, equatable value, so two null
// cells are equal while null differs from every string. A relation has at
// most MaxColumns (16) columns.
//
// For every target column a, Discover returns each minimal left-hand side X
// (a subset of the other columns, the empty set allowed) such that
// X -> a holds: any two rows agreeing on every column in X must also agree
// on a. X is minimal when no proper subset of X still determines a.
// Duplicate rows never invalidate a dependency. Results are ordered by
// target column and then lexicographically by the ascending left-hand-side
// index list. Every rejected candidate keeps one original counterexample
// pair of zero-based row indices.
package dataeng
