// Package dataeng decodes compact binary point, line-string, polygon, and
// geometry-collection objects that may each choose big- or little-endian
// encoding.
//
// Decode validates finite coordinates, polygon ring closure, total point and
// collection-depth limits, truncation, trailing bytes, and impossible counts.
// Errors carry a JSONPath-like geometry path and a byte offset.
package dataeng
