// Package dataeng turns closed axis-aligned rectangles in a b-bit
// Morton-ordered grid into maximal half-open integer code intervals.
//
// Coordinates are b-bit unsigned integers, with 1 <= b <= 12. The Morton
// code interleaves coordinate bits from least significant to most
// significant: x0, y0, x1, y1, ... . A quadtree node at depth d is denoted
// by the 2d most significant code bits, starting with the highest bit pair;
// its code set is one aligned block of 4^(b-d) consecutive codes.
//
// Domain.Query returns maximal contiguous code intervals together with the
// quadtree prefixes that exactly tile each interval. If the caller's
// interval budget is exceeded, Query returns the confirmed prefix in Morton
// order and leaves the exact remainder as unexpanded quadtree prefixes.
package dataeng
