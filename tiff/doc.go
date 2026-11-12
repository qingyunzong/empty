// Package tiff reads a restricted, baseline-like subset of TIFF: 8-bit
// unsigned samples, no compression or PackBits compression, and planar
// configuration 1 (chunky) or 2 (planar).
//
// The parser understands only the three value types BYTE (1), SHORT (3) and
// LONG (4). Unknown tags are skipped after their value/offset byte range is
// validated; duplicate tags, IFD cycles and truncated directories are rejected.
// No color, coordinate or orientation transforms are applied: samples are
// returned as stored.
package tiff
