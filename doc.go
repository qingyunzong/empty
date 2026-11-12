// Package dataeng restores real formulas for every formula cell of one
// worksheet, including slave cells of OOXML shared formulas that carry no
// formula text of their own.
//
// Restore accepts parsed Cell values with strict uppercase A1 coordinates
// and optional Formula objects. It validates master/slave relationships and
// shared rectangles, then rebuilds slave formulas by shifting the relative
// A1 references of their master by the master-to-slave row/column offset.
// ShiftFormula exposes the token-level rewriter independently. ZIP reading
// and formula evaluation are intentionally outside the package scope.
package dataeng
